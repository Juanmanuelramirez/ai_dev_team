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
        
        // Retornar JSON string para que el frontend lo parsee
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
    description: "Escribe un archivo. Usa rutas relativas (ej. 'src/index.js').",
    schema: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Ruta relativa del archivo." },
            content: { type: "string", description: "Contenido del archivo." },
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
// 4. Prompts (MEJORADOS: Identidad y Pausas)
// ---------------------------------

const PM_PROMPT = `Eres "Sofía", la Project Manager.
Tu objetivo es coordinar el proyecto y asegurar que el usuario esté feliz con la tecnología.

**TU PRIMER PASO ES OBLIGATORIO:**
1.  Lee la solicitud del usuario.
2.  **NO ASUMAS NADA**. Aunque el usuario diga "HTML", debes confirmar el enfoque.
3.  Propón un "Stack Tecnológico" recomendado y una breve lista de funcionalidades.
4.  Pregunta explícitamente: "¿Te parece bien este plan o prefieres otra tecnología?".
5.  Usa el formato: "CLARIFICATION_NEEDED: [Tu propuesta y pregunta]".

**SOLO CUANDO EL USUARIO CONFIRME:**
1.  Crea el archivo 'documentacion/requerimientos.md'.
2.  Pasa el turno al Arquitecto.`;

const ARCHITECT_PROMPT = `Eres "Mateo", el Arquitecto.
Recibes los requerimientos confirmados de Sofía.

**TUS TAREAS:**
1.  Define la estructura de carpetas y archivos.
2.  Crea el archivo 'documentacion/arquitectura.md' usando 'file_write'.
3.  Pasa el turno al Desarrollador con instrucciones precisas.`;

const DEVELOPER_PROMPT = `Eres "Lucas", el Desarrollador.
Recibes el plan técnico.

**TUS TAREAS:**
1.  Escribe el código real usando 'file_write'.
2.  Implementa todos los archivos necesarios (HTML, CSS, JS).
3.  Cuando termines una versión funcional, **DETENTE** y pide feedback.
4.  Responde: "PROJECT_COMPLETED: He desplegado la versión v1. ¿Quieres probarla o cambiar algo?".`;

// ---------------------------------
// 5. Nodos
// ---------------------------------

const createAgentNode = (rolePrompt, tools) => async (state) => {
    const messages = state.messages;
    const systemMessage = new SystemMessage(rolePrompt);
    const modelWithTools = model.bindTools(tools);
    
    const aiResponse = await modelWithTools.invoke([systemMessage, ...messages]);
    
    const agentNameMatch = rolePrompt.match(/"([^"]+)"/);
    const agentName = agentNameMatch ? agentNameMatch[1] : "Agente";

    // --- SANITIZACIÓN VISUAL ---
    // Si el mensaje es solo uso de herramientas (tool_calls), no lo mostramos como texto.
    // El nodo de herramientas se encargará de mostrar "Archivo creado..."
    let logEntries = [];
    if (aiResponse.content && typeof aiResponse.content === 'string' && aiResponse.content.trim().length > 0) {
        logEntries.push(`**${agentName}**: ${aiResponse.content}`);
    }
    
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
        
        // Solo mostramos logs visuales si es file_write (para el Canvas)
        // Ocultamos google_search y otros para no saturar
        if (toolCall.name === 'file_write') {
             logEntries.push(`**Herramienta (${toolCall.name})**: ${output}`);
        }

        toolMessages.push(new ToolMessage(output, toolCall.id));
    }
    return { messages: toolMessages, log: logEntries };
};

const humanInputNode = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const question = lastMessage.content
        .replace("CLARIFICATION_NEEDED:", "")
        .replace("PROJECT_COMPLETED:", "")
        .trim();
        
    // Este nodo solo prepara el estado para la UI, el log visual ya lo puso el agente antes
    return { 
        status: "waiting_for_human", 
        question: question
    };
};

const routeWork = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage.tool_calls?.length) return "tools";
    
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

// Rutas del Developer
workflow.addConditionalEdges("developer", routeWork, {
    "tools": "tool_node",
    "clarify": "human_node", // Loop de feedback
    "review": "human_node",  // Loop de feedback final
    "end": END,
    "continue": END
});

// Retorno de herramientas
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

// Rutas del PM
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

// Rutas del Arquitecto
workflow.addConditionalEdges("architect", (state) => {
    const last = state.messages[state.messages.length - 1];
    if (last.tool_calls?.length) return "tools_arch";
    return "developer";
}, {
    "tools_arch": "tool_node",
    "developer": "developer"
});

// --- CAMBIO CRÍTICO: DETENER LA EJECUCIÓN ---
// Cuando llegamos al nodo humano, terminamos este "turno" de ejecución.
// Esto permite que el servidor espere la respuesta real del usuario.
workflow.addEdge("human_node", END); 

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

// Función para correr el grafo paso a paso y hacer streaming al estado global
async function runAgentProcess(thread_id, inputConfig) {
    try {
        const stream = await app.stream(inputConfig, { 
            configurable: { thread_id },
            streamMode: "updates"
        });

        for await (const chunk of stream) {
            const nodeName = Object.keys(chunk)[0];
            const update = chunk[nodeName];
            const currentState = globalState.get(thread_id) || {};

            // Acumular logs
            if (update.log && Array.isArray(update.log)) {
                const existingLogs = currentState.log || [];
                currentState.log = [...existingLogs, ...update.log];
            }
            
            // Actualizar estado
            if (update.status) {
                currentState.status = update.status;
                if (update.question) currentState.question = update.question;
            } else {
                currentState.status = "running";
            }

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
        log: [`**Sistema**: Conectando con Sofía (PM)...`]
    };
    
    globalState.set(thread_id, { ...initialState, status: "running" });
    runAgentProcess(thread_id, initialState);
    res.json({ thread_id });
});

expressApp.get('/get_status/:thread_id', (req, res) => {
    const state = globalState.get(req.params.thread_id);
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
    globalState.set(thread_id, currentState);
    
    // Reanudamos el proceso inyectando la respuesta del humano
    // LangGraph sabrá a quién entregársela porque el estado se preservó
    runAgentProcess(thread_id, { messages: [new HumanMessage(response)] });
    res.json({ status: "resumed" });
});

expressApp.listen(port, '0.0.0.0', () => {
    console.log(`--- Server running on port ${port} ---`);
    console.log(`--- MODE: Interactive Streaming | MODEL: ${MODEL_NAME} ---`);
});