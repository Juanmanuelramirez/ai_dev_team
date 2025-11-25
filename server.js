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
        
        // Retornar JSON string para que el frontend lo parsee y muestre en Canvas
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
    description: "Escribe un archivo en el sistema. Entrada: file_path (ruta relativa) y content.",
    schema: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Ruta relativa, ej: 'index.html'" },
            content: { type: "string", description: "Contenido completo del archivo." },
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
    log: { value: (a, b) => a.concat(b), default: () => [] },
    status: { value: (a, b) => b, default: () => "running" },
    question: { value: (a, b) => b, default: () => "" }
};

// ---------------------------------
// 4. Prompts (MEJORADOS: Identidad y Clarificación Estricta)
// ---------------------------------

const PM_PROMPT = `Eres "Sofía", la Project Manager.
Tu objetivo es coordinar el proyecto y asegurar que los requerimientos sean sólidos.

**PROTOCOLO OBLIGATORIO DE CLARIFICACIÓN:**
1. Al recibir una solicitud, evalúa su detalle.
2. Si el usuario dice algo simple como "crea un juego" o "haz una web", **NO AVANCES**.
3. Debes responder con: "CLARIFICATION_NEEDED: [Tu pregunta para definir alcance, tecnología o estilo]".
4. Solo si el requerimiento tiene detalles técnicos y de negocio claros, procede a planificar.

**FASE DE PLANIFICACIÓN:**
1. Crea 'documentacion/requerimientos.md' con 'file_write'.
2. Pasa el turno al Arquitecto.`;

const ARCHITECT_PROMPT = `Eres "Mateo", el Arquitecto.
Recibes los requerimientos de Sofía.

**TUS TAREAS:**
1. Define la estructura técnica.
2. Crea 'documentacion/arquitectura.md' usando 'file_write'.
3. Pasa el turno al Desarrollador.`;

const DEVELOPER_PROMPT = `Eres "Lucas", el Desarrollador.
Recibes el plan técnico.

**TUS TAREAS:**
1. Escribe el código real.
2. Usa 'file_write' para crear CADA archivo (HTML, CSS, JS) necesario.
3. Cuando termines, **NO** cierres el proyecto.
4. Responde con "PROJECT_COMPLETED: He terminado la primera versión. ¿Deseas realizar alguna mejora o cambio?".`;

// ---------------------------------
// 5. Nodos
// ---------------------------------

const createAgentNode = (rolePrompt, tools) => async (state) => {
    const messages = state.messages;
    const systemMessage = new SystemMessage(rolePrompt);
    const modelWithTools = model.bindTools(tools);
    
    const aiResponse = await modelWithTools.invoke([systemMessage, ...messages]);
    
    // --- LOGICA DE IDENTIDAD ---
    const agentNameMatch = rolePrompt.match(/"([^"]+)"/);
    const agentName = agentNameMatch ? agentNameMatch[1] : "Agente";

    // --- SANITIZACIÓN DE LOGS ---
    // Eliminamos logs de uso de herramientas para limpiar la interfaz visual
    let logEntries = [];
    let content = aiResponse.content;

    // Si hay contenido de texto real, lo mostramos
    if (content && typeof content === 'string' && content.trim().length > 0) {
        logEntries.push(`**${agentName}**: ${content}`);
    } 
    // Si solo son llamadas a herramientas (tool_calls), NO generamos log de texto aquí.
    // El log visual vendrá del nodo 'loggingToolNode' cuando la herramienta termine.
    
    return { messages: [aiResponse], log: logEntries };
};

const loggingToolNode = async (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage.tool_calls?.length) return { log: [] };

    const toolMessages = [];
    const logEntries = [];

    for (const toolCall of lastMessage.tool_calls) {
        const tool = allTools.find(t => t.name === toolCall.name);
        if (!tool) {
            toolMessages.push(new ToolMessage("Tool not found", toolCall.id));
            continue;
        }
        
        let output;
        try {
            output = await tool.invoke(toolCall.args);
        } catch (e) {
            output = JSON.stringify({ error: e.message });
        }
        
        // Si es file_write, el output es JSON para el Canvas.
        let logMsg = output;
        if (toolCall.name === 'file_write') {
             // Hack: Prefix para que el frontend lo detecte
             logMsg = output; 
        } else if (output.length > 200) {
            logMsg = output.substring(0, 200) + "...";
        }

        logEntries.push(`**Herramienta (${toolCall.name})**: ${logMsg}`);
        toolMessages.push(new ToolMessage(output, toolCall.id));
    }
    return { messages: toolMessages, log: logEntries };
};

const humanInputNode = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    // Limpiamos el marcador de protocolo interno antes de mostrar al usuario
    const question = lastMessage.content
        .replace("CLARIFICATION_NEEDED:", "")
        .replace("PROJECT_COMPLETED:", "")
        .trim();
        
    return { 
        status: "waiting_for_human", 
        question: question, 
        log: [`**Sofía**: ${question}`] 
    };
};

const routeWork = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage.tool_calls?.length) return "tools";
    
    // Ambos casos llevan al humano: Clarificación (inicio) o Validación (fin)
    if (lastMessage.content.includes("CLARIFICATION_NEEDED")) return "clarify";
    if (lastMessage.content.includes("PROJECT_COMPLETED")) return "review";
    
    return "continue";
};

// ---------------------------------
// 6. Construcción del Grafo
// ---------------------------------

const workflow = new StateGraph({ channels: appState });

workflow.addNode("pm", createAgentNode(PM_PROMPT, [fileWriteTool])); 
workflow.addNode("architect", createAgentNode(ARCHITECT_PROMPT, [googleSearchTool, fileWriteTool]));
workflow.addNode("developer", createAgentNode(DEVELOPER_PROMPT, [fileWriteTool, fileReadTool, runTerminalCommandTool]));

workflow.addNode("tool_node", loggingToolNode);
workflow.addNode("human_node", humanInputNode);

workflow.setEntryPoint("pm");
workflow.addEdge("pm", "architect");
workflow.addEdge("architect", "developer");

workflow.addConditionalEdges("developer", routeWork, {
    "tools": "tool_node",
    "clarify": "human_node",
    "review": "human_node", // Ahora permite revisión en lugar de END
    "end": END,
    "continue": END
});

workflow.addConditionalEdges("tool_node", (state) => {
    const lastToolMsg = state.messages[state.messages.length - 1];
    const content = lastToolMsg.content; 
    
    if (content.includes("requerimientos.md")) return "architect";
    if (content.includes("arquitectura.md")) return "developer";
    
    return "developer"; 
}, {
    "architect": "architect",
    "developer": "developer"
});

workflow.addConditionalEdges("pm", (state) => {
    const last = state.messages[state.messages.length - 1];
    if (last.tool_calls?.length) return "tools_pm"; 
    if (last.content.includes("CLARIFICATION_NEEDED")) return "clarify";
    return "architect";
}, {
    "tools_pm": "tool_node",
    "clarify": "human_node",
    "architect": "architect"
});

workflow.addConditionalEdges("architect", (state) => {
    const last = state.messages[state.messages.length - 1];
    if (last.tool_calls?.length) return "tools_arch";
    return "developer";
}, {
    "tools_arch": "tool_node",
    "developer": "developer"
});

// El input humano vuelve al PM para re-evaluar (ciclo de feedback)
workflow.addEdge("human_node", "pm"); 

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

// --- FUNCIÓN CORE CON STREAMING ITERATIVO ---
// Esto soluciona la visualización en "tiempo real"
async function runAgentProcess(thread_id, inputConfig) {
    try {
        // Usamos stream para obtener actualizaciones paso a paso
        const stream = await app.stream(inputConfig, { 
            configurable: { thread_id },
            streamMode: "updates"
        });

        for await (const chunk of stream) {
            // Obtenemos el estado actual
            const currentState = globalState.get(thread_id) || {};
            const nodeName = Object.keys(chunk)[0];
            const update = chunk[nodeName];

            // Actualizamos logs incrementales
            if (update.log && Array.isArray(update.log)) {
                const existingLogs = currentState.log || [];
                currentState.log = [...existingLogs, ...update.log];
            }
            
            // Actualizamos estado
            if (update.status) {
                currentState.status = update.status;
                if (update.question) currentState.question = update.question;
            } else {
                currentState.status = "running";
            }

            // GUARDAR EN TIEMPO REAL: Esto permite que el frontend (polling) vea el progreso
            globalState.set(thread_id, currentState);
        }

    } catch (e) {
        console.error("Error en stream:", e);
        const currentState = globalState.get(thread_id) || {};
        currentState.status = "error";
        currentState.log = [...(currentState.log || []), `**Error Crítico**: ${e.message}`];
        globalState.set(thread_id, currentState);
    }
}

expressApp.post('/start_run', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Falta el prompt" });

    const thread_id = `thread_${Date.now()}`;
    const initialState = {
        messages: [new HumanMessage(prompt)],
        log: [`**Sistema**: Conectando con el equipo...`]
    };
    
    globalState.set(thread_id, { ...initialState, status: "running" });

    // Ejecutamos en background sin await para liberar la request
    runAgentProcess(thread_id, initialState);

    res.json({ thread_id });
});

expressApp.get('/get_status/:thread_id', (req, res) => {
    const state = globalState.get(req.params.thread_id);
    
    // Limpieza básica de duplicados visuales
    if (state && state.log) {
        state.log = [...new Set(state.log)];
    }

    state ? res.json(state) : res.status(404).json({ error: "Not found" });
});

expressApp.post('/respond', (req, res) => {
    const { thread_id, response } = req.body;
    const currentState = globalState.get(thread_id);
    if (!currentState || currentState.status !== "waiting_for_human") return res.status(400).json({ error: "Invalid state" });

    currentState.status = "running";
    currentState.log.push(`**Humano**: ${response}`);
    
    // Importante: Pasamos el mensaje como un objeto HumanMessage nuevo
    runAgentProcess(thread_id, { messages: [new HumanMessage(response)] });
    res.json({ status: "resumed" });
});

expressApp.listen(port, '0.0.0.0', () => {
    console.log(`--- Server running on port ${port} ---`);
    console.log(`--- MODE: Step-by-Step Streaming | MODEL: ${MODEL_NAME} ---`);
});