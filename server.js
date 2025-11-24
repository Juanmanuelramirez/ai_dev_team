import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

// --- Imports de LangChain y Google ---
import { tool } from '@langchain/core/tools';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { StateGraph, END } from '@langchain/langgraph';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { google } from 'googleapis'; 

// ---------------------------------
// --- Configuración de API Keys ---
// ---------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "TU_GEMINI_API_KEY"; 
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "TU_GOOGLE_API_KEY"; 
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || "TU_GOOGLE_CSE_ID";

if (!process.env.GEMINI_API_KEY && GEMINI_API_KEY === "TU_GEMINI_API_KEY") {
    console.warn("⚠️ ADVERTENCIA: GEMINI_API_KEY no configurada.");
}

const customsearch = google.customsearch("v1");

// ---------------------------------
// 1. Definición de Herramientas (Tools)
// ---------------------------------

const fileWriteTool = tool(async ({ file_path, content }) => {
    try {
        const fullPath = path.join(__dirname, 'proyecto_generado', file_path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        
        // Importante: Retornar JSON string para que el frontend lo parsee
        return JSON.stringify({
            status: "file_created",
            path: file_path, 
            content: content 
        });
    } catch (e) {
        return JSON.stringify({ status: "error", message: `Error al escribir archivo ${file_path}: ${e.message}` });
    }
}, {
    name: "file_write",
    description: "Escribe un archivo en el sistema. Entrada: file_path (ruta relativa) y content (código completo).",
    schema: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Ruta relativa, ej: 'index.html' o 'js/app.js'" },
            content: { type: "string", description: "Contenido completo del archivo en texto plano." },
        },
        required: ["file_path", "content"],
    },
});

const fileReadTool = tool(async ({ file_path }) => {
    return JSON.stringify({ status: "error", message: "Lectura no implementada." });
}, {
    name: "file_read",
    description: "Lee el contenido de un archivo.",
    schema: { type: "object", properties: { file_path: { type: "string" } } },
});

const runTerminalCommandTool = tool(async ({ command }) => {
    return JSON.stringify({ status: "error", message: "Terminal deshabilitada por seguridad." });
}, {
    name: "run_terminal_command",
    description: "Ejecuta comandos.",
    schema: { type: "object", properties: { command: { type: "string" } } },
});

const googleSearchTool = tool(async ({ query }) => {
    try {
        if (!process.env.GOOGLE_API_KEY && GOOGLE_API_KEY === "TU_GOOGLE_API_KEY") {
             return JSON.stringify({ status: "error", message: "Falta configuración de Google Search API." });
        }
        const response = await customsearch.cse.list({
            auth: GOOGLE_API_KEY,
            cx: GOOGLE_CSE_ID,
            q: query,
        });
        const items = response.data.items || [];
        const snippets = items.map(item => ({
            title: item.title,
            snippet: item.snippet,
            source: item.link,
        })).slice(0, 5);
        return JSON.stringify(snippets);
    } catch (e) {
        return JSON.stringify({ status: "error", message: `Error en Google Search: ${e.message}` });
    }
}, {
    name: "google_search",
    description: "Busca en Google información técnica.",
    schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
    },
});

const allTools = [fileWriteTool, fileReadTool, runTerminalCommandTool, googleSearchTool];

// ---------------------------------
// 2. Definición del Modelo
// ---------------------------------
const MODEL_NAME = "gemini-2.5-flash-preview-09-2025"; 

const model = new ChatGoogleGenerativeAI({
    apiKey: GEMINI_API_KEY,
    model: MODEL_NAME, 
    temperature: 0.7,
});

// ---------------------------------
// 3. Estado y Grafo (LangGraph)
// ---------------------------------

const globalState = new Map();

const appState = {
    messages: { value: (a, b) => a.concat(b), default: () => [] },
    // 'log' solo almacena strings para el frontend
    log: { value: (a, b) => a.concat(b), default: () => [] },
    status: { value: (a, b) => b, default: () => "running" },
    question: { value: (a, b) => b, default: () => "" }
};

// ---------------------------------
// 4. Prompts
// ---------------------------------

const PM_PROMPT = `Eres el Project Manager "Sofía".
Tu objetivo es coordinar al equipo. Recibes la solicitud del usuario.
1. Analiza la solicitud.
2. Genera un plan conciso para el "Arquitecto".
3. NO escribas código. Solo define el alcance.`;

const ARCHITECT_PROMPT = `Eres el Arquitecto "Mateo".
Recibes el plan del PM.
1. Decide la estructura de archivos necesaria (index.html, styles.css, script.js, etc.).
2. Define las tecnologías (HTML5, Tailwind, Vanilla JS).
3. Entrega un plan técnico detallado al "Desarrollador".`;

const DEVELOPER_PROMPT = `Eres el Desarrollador "Lucas".
Recibes el plan técnico. TU ÚNICO OBJETIVO ES ESCRIBIR CÓDIGO.
1. Debes usar la herramienta 'file_write' para crear CADA archivo definido por el Arquitecto.
2. Escribe el código completo y funcional.
3. Si terminaste de crear todos los archivos, responde con "PROJECT_COMPLETED".
4. Si algo no está claro, responde "CLARIFICATION_NEEDED".`;

// ---------------------------------
// 5. Nodos
// ---------------------------------

const createAgentNode = (rolePrompt, tools) => async (state) => {
    const messages = state.messages;
    const systemMessage = new SystemMessage(rolePrompt);
    const modelWithTools = model.bindTools(tools);
    
    // Llamada al modelo
    const aiResponse = await modelWithTools.invoke([systemMessage, ...messages]);
    
    // --- CORRECCIÓN DE LOGS [object Object] ---
    let cleanContent = aiResponse.content;
    
    // Si el contenido es vacío (uso de herramienta) o no es string
    if (!cleanContent || typeof cleanContent !== 'string') {
        if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
            cleanContent = `*(Solicitando uso de herramientas: ${aiResponse.tool_calls.map(t => t.name).join(', ')})*`;
        } else {
            // Si es un objeto desconocido, lo pasamos a string para ver qué es
            cleanContent = JSON.stringify(aiResponse.content);
        }
    }

    const agentName = rolePrompt.match(/"([^"]+)"/)?.[1] || "Agente";
    const logEntry = `**${agentName}**: ${cleanContent}`;
    
    return { messages: [aiResponse], log: [logEntry] };
};

const loggingToolNode = async (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage.tool_calls?.length) return { log: ["**Sistema**: Error, intento de herramienta sin datos."] };

    const toolMessages = [];
    const logEntries = [];

    for (const toolCall of lastMessage.tool_calls) {
        const tool = allTools.find(t => t.name === toolCall.name);
        if (!tool) {
            toolMessages.push(new ToolMessage("Tool not found", toolCall.id));
            continue;
        }
        
        // Ejecutar herramienta
        let output;
        try {
            output = await tool.invoke(toolCall.args);
        } catch (e) {
            output = JSON.stringify({ error: e.message });
        }
        
        // El output de file_write ya es un JSON string listo para el frontend
        // Si es otra herramienta, la mostramos simple
        let logMsg = output;
        if (toolCall.name !== 'file_write') {
             // Simplificar log para búsquedas largas
             if (output.length > 200) logMsg = output.substring(0, 200) + "...";
        }

        // Prefijo especial para que el frontend detecte archivos
        logEntries.push(`**Herramienta (${toolCall.name})**: ${logMsg}`);
        toolMessages.push(new ToolMessage(output, toolCall.id));
    }
    return { messages: toolMessages, log: logEntries };
};

const humanInputNode = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const question = lastMessage.content.replace("CLARIFICATION_NEEDED:", "").trim();
    return { status: "waiting_for_human", question: question, log: [`**Sofía**: Necesitamos tu ayuda: ${question}`] };
};

const routeWork = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage.tool_calls?.length) return "tools";
    if (lastMessage.content.includes("CLARIFICATION_NEEDED")) return "clarify";
    if (lastMessage.content.includes("PROJECT_COMPLETED")) return "end";
    return "continue";
};

// ---------------------------------
// 6. Construcción del Grafo
// ---------------------------------

const workflow = new StateGraph({ channels: appState });
workflow.addNode("pm", createAgentNode(PM_PROMPT, []));
workflow.addNode("architect", createAgentNode(ARCHITECT_PROMPT, [googleSearchTool]));
workflow.addNode("developer", createAgentNode(DEVELOPER_PROMPT, [fileWriteTool, fileReadTool, runTerminalCommandTool]));
workflow.addNode("tool_node", loggingToolNode);
workflow.addNode("human_node", humanInputNode);

workflow.setEntryPoint("pm");
workflow.addEdge("pm", "architect");
workflow.addEdge("architect", "developer");
workflow.addConditionalEdges("developer", routeWork, {
    "tools": "tool_node",
    "clarify": "human_node",
    "end": END,
    "continue": END // Por defecto termina, o podríamos hacer loop si queremos que siga hablando
});
workflow.addEdge("tool_node", "developer");
workflow.addEdge("human_node", "developer");

const app = workflow.compile();

// ---------------------------------
// 7. Backend Express
// ---------------------------------

const expressApp = express();
const port = process.env.PORT || 8000;

expressApp.use(cors());
expressApp.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
expressApp.use(express.static(path.join(__dirname, 'public')));

expressApp.get('/favicon.ico', (req, res) => res.status(204).end());

// --- FUNCIÓN CORE: Ejecución con Streaming ---
async function runAgentProcess(thread_id, inputConfig) {
    try {
        // Usamos .stream() en lugar de .invoke() para tener datos en tiempo real
        const stream = await app.stream(inputConfig, { 
            configurable: { thread_id },
            streamMode: "updates" // Recibir solo los cambios (deltas)
        });

        for await (const chunk of stream) {
            // 'chunk' es un objeto con la clave del nodo que se ejecutó (ej: { developer: {...} })
            const nodeName = Object.keys(chunk)[0];
            const update = chunk[nodeName];

            const currentState = globalState.get(thread_id);
            if (!currentState) break; // Seguridad

            // Si hay nuevos logs, los agregamos al estado global
            if (update.log && Array.isArray(update.log)) {
                currentState.log.push(...update.log);
            }
            
            // Si el estado cambió a waiting, actualizamos
            if (update.status) {
                currentState.status = update.status;
                if (update.question) currentState.question = update.question;
            } else {
                currentState.status = "running";
            }

            // Guardamos el estado actualizado para que el frontend lo lea en el próximo poll
            globalState.set(thread_id, currentState);
        }

        // Al terminar el stream
        const finalState = globalState.get(thread_id);
        if (finalState.status !== "waiting_for_human") {
            finalState.status = "finished";
            finalState.log.push("**Sistema**: Proceso finalizado.");
        }

    } catch (e) {
        console.error("Error en stream:", e);
        const currentState = globalState.get(thread_id);
        if (currentState) {
            currentState.status = "error";
            currentState.log.push(`**Error Crítico**: ${e.message}`);
        }
    }
}

expressApp.post('/start_run', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Falta el prompt" });

    const thread_id = `thread_${Date.now()}`;
    
    // Estado inicial
    const initialState = {
        messages: [new HumanMessage(prompt)],
        log: [`**Sistema**: Iniciando equipo con modelo ${MODEL_NAME}...`]
    };
    
    globalState.set(thread_id, { ...initialState, status: "running" });

    // Iniciar proceso en background (sin await para no bloquear response)
    runAgentProcess(thread_id, initialState);

    res.json({ thread_id });
});

expressApp.get('/get_status/:thread_id', (req, res) => {
    const state = globalState.get(req.params.thread_id);
    state ? res.json(state) : res.status(404).json({ error: "Not found" });
});

expressApp.post('/respond', (req, res) => {
    const { thread_id, response } = req.body;
    const currentState = globalState.get(thread_id);
    if (!currentState || currentState.status !== "waiting_for_human") return res.status(400).json({ error: "Invalid state" });

    // Actualizar log inmediato
    currentState.status = "running";
    currentState.log.push(`**Humano**: ${response}`);
    
    // Reanudar proceso con la respuesta humana
    runAgentProcess(thread_id, { messages: [new HumanMessage(response)] });

    res.json({ status: "resumed" });
});

expressApp.listen(port, '0.0.0.0', () => {
    console.log(`--- Server running on port ${port} ---`);
    console.log(`--- MODE: Streaming Enabled | MODEL: ${MODEL_NAME} ---`);
});