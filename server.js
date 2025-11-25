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
        
        // Importante: Retornar JSON string para que el frontend lo parsee y muestre en Canvas
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
// 2. Definición del Modelo (QUE SÍ FUNCIONA)
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
// 4. Prompts (MEJORADOS: Identidad, Archivos y Clarificación)
// ---------------------------------

const PM_PROMPT = `Eres "Sofía", la Project Manager.
Tu objetivo es coordinar el proyecto.

**FASE 1: CLARIFICACIÓN**
1. Analiza la solicitud del usuario. ¿Es vaga? (Ej: "Haz una web", "Quiero un juego").
2. Si es vaga, **DETENTE** y responde: "CLARIFICATION_NEEDED: [Pregunta para aclarar el alcance]".
3. Si es clara, procede.

**FASE 2: PLANIFICACIÓN**
1. Si el requerimiento es claro, define un plan.
2. Crea un archivo 'documentacion/requerimientos.md' usando 'file_write' con el detalle.
3. Pasa el turno al Arquitecto.`;

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
3. Al terminar, responde "PROJECT_COMPLETED".`;

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

    // --- SANITIZACIÓN ---
    let cleanContent = aiResponse.content;
    if (!cleanContent || typeof cleanContent !== 'string') {
        if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
            cleanContent = `*(Usando herramientas: ${aiResponse.tool_calls.map(t => t.name).join(', ')})*`;
        } else {
            cleanContent = "";
        }
    }

    const logEntry = `**${agentName}**: ${cleanContent}`;
    return { messages: [aiResponse], log: [logEntry] };
};

const loggingToolNode = async (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage.tool_calls?.length) return { log: ["**Sistema**: Error tools."] };

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
        
        // Formato JSON especial para que el frontend detecte archivos
        // Si es file_write, el output YA ES un JSON string del tool.
        let logMsg = output;
        if (toolCall.name === 'file_write') {
             // Hack: Le ponemos un prefijo para que el frontend lo vea fácil en el log
             // Pero el 'output' real se guarda en messages para el agente
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
    const question = lastMessage.content.replace("CLARIFICATION_NEEDED:", "").trim();
    return { status: "waiting_for_human", question: question, log: [`**Sofía**: ${question}`] };
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

// Todos tienen acceso a escribir archivos
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
    "end": END,
    "continue": END
});

// Lógica simple de retorno de herramientas
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

// Retorno del humano al PM
workflow.addConditionalEdges("pm", (state) => {
    const last = state.messages[state.messages.length - 1];
    if (last.tool_calls?.length) return "tools_pm"; // Si PM usa tools
    if (last.content.includes("CLARIFICATION_NEEDED")) return "clarify";
    return "architect";
}, {
    "tools_pm": "tool_node",
    "clarify": "human_node",
    "architect": "architect"
});

// Si Architect usa tools
workflow.addConditionalEdges("architect", (state) => {
    const last = state.messages[state.messages.length - 1];
    if (last.tool_calls?.length) return "tools_arch";
    return "developer";
}, {
    "tools_arch": "tool_node",
    "developer": "developer"
});

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

// --- FUNCIÓN CORE SIN STREAMING (MÁS SEGURA POR AHORA) ---
async function runAgentProcess(thread_id, inputConfig) {
    try {
        // Usamos invoke en lugar de stream para asegurar respuesta completa JSON
        const finalState = await app.invoke(inputConfig, { configurable: { thread_id } });
        
        // Actualizamos el estado global con el resultado final
        const currentState = globalState.get(thread_id) || {};
        
        // Fusionamos logs
        const newLogs = finalState.log || [];
        currentState.log = currentState.log ? [...currentState.log, ...newLogs] : newLogs;
        
        currentState.status = finalState.status === "waiting_for_human" ? "waiting_for_human" : "finished";
        if (finalState.question) currentState.question = finalState.question;
        
        globalState.set(thread_id, currentState);

    } catch (e) {
        console.error("Error en invoke:", e);
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
        log: [`**Sistema**: Iniciando equipo...`]
    };
    
    globalState.set(thread_id, { ...initialState, status: "running" });

    // Ejecutamos en background
    runAgentProcess(thread_id, initialState);

    res.json({ thread_id });
});

expressApp.get('/get_status/:thread_id', (req, res) => {
    const state = globalState.get(req.params.thread_id);
    
    // Filtramos mensajes duplicados en el log para el frontend
    if (state && state.log) {
        // Hack simple para deduplicar logs si invoke retorna todo el historial
        // En una app real, usaríamos IDs de mensaje.
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
    
    runAgentProcess(thread_id, { messages: [new HumanMessage(response)] });
    res.json({ status: "resumed" });
});

expressApp.listen(port, '0.0.0.0', () => {
    console.log(`--- Server running on port ${port} ---`);
    console.log(`--- MODE: Standard Invoke | MODEL: ${MODEL_NAME} ---`);
});