import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

// --- Imports de LangChain y Google ---
import { tool } from '@langchain/core/tools';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
// IMPORTANTE: Añadimos MemorySaver para recordar la conversación
import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
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

// Memoria en RAM para guardar el estado de la conversación entre turnos
const checkpointer = new MemorySaver();

// Estado Global para el Frontend (Logs visuales)
const globalFrontendState = new Map();

const appState = {
    messages: { value: (a, b) => a.concat(b), default: () => [] },
    // 'log' y 'status' son auxiliares para pasar info al frontend
    log: { value: (a, b) => a.concat(b), default: () => [] },
    status: { value: (a, b) => b, default: () => "running" },
    question: { value: (a, b) => b, default: () => "" }
};

// ---------------------------------
// 4. Prompts (ESTRICTOS - FIX DE INTERACCIÓN)
// ---------------------------------

const PM_PROMPT = `Eres "Sofía", la Project Manager.

**REGLA 1: CLARIFICACIÓN OBLIGATORIA**
Si es la primera vez que hablas con el usuario:
1. NO inicies el proyecto aún.
2. Saluda y propón un "Stack Tecnológico" basado en su idea.
3. Pregunta: "¿Te parece bien este stack o prefieres cambiar algo?".
4. Responde con: "CLARIFICATION_NEEDED: [Tu propuesta y pregunta]".
5. **CRÍTICO: NO uses ninguna herramienta (como file_write) en este turno. Tu única tarea es preguntar.**

**REGLA 2: GESTIÓN DE CAMBIOS**
Si el usuario pide un cambio (ej. "Hazlo mobile", "Cambia el color"):
1. Confirma el cambio.
2. Actualiza el archivo 'documentacion/requerimientos.md'.
3. Pasa el turno al Arquitecto.

**REGLA 3: FORMATO**
Sé breve y profesional.`;

const ARCHITECT_PROMPT = `Eres "Mateo", el Arquitecto.
1. Lee los requerimientos.
2. Actualiza/Crea 'documentacion/arquitectura.md' con la estructura de archivos.
3. Pasa el turno al Desarrollador.`;

const DEVELOPER_PROMPT = `Eres "Lucas", el Desarrollador.
1. Lee la arquitectura.
2. Escribe/Actualiza el código usando 'file_write'.
3. Crea TODOS los archivos necesarios.
4. Al finalizar, responde SIEMPRE: "PROJECT_COMPLETED: He aplicado los cambios. ¿Qué más necesitas?".`;

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

    // --- LIMPIEZA DE LOGS ---
    let logEntries = [];
    const content = aiResponse.content;

    // Solo mostramos texto real. Si el agente solo usa herramientas, NO mostramos nada aquí.
    if (content && typeof content === 'string' && content.trim().length > 0) {
        logEntries.push(`**${agentName}**: ${content}`);
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
        
        // SOLO mostramos logs visuales si se crea un archivo
        if (toolCall.name === 'file_write') {
             logEntries.push(`**Herramienta (${toolCall.name})**: ${output}`);
        }
        // Ocultamos google_search y otros para limpieza

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
        
    return { 
        status: "waiting_for_human", 
        question: question
    };
};

const routeWork = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage.tool_calls?.length) return "tools";
    
    // Puntos de parada para interacción humana
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

// Rutas condicionales
workflow.addConditionalEdges("developer", routeWork, {
    "tools": "tool_node",
    "clarify": "human_node",
    "review": "human_node", 
    "end": END,
    "continue": END
});

workflow.addConditionalEdges("tool_node", (state) => {
    const lastToolMsg = state.messages[state.messages.length - 1];
    const content = lastToolMsg.content; 
    // Routing inteligente según el archivo tocado
    if (content.includes("requerimientos.md")) return "architect";
    if (content.includes("arquitectura.md")) return "developer";
    return "developer"; 
}, {
    "architect": "architect",
    "developer": "developer"
});

// --- FIX DEL ROUTING DE PM ---
// Damos prioridad a la clarificación sobre las herramientas.
// Esto previene que el uso accidental de tools oculte la pregunta al usuario.
workflow.addConditionalEdges("pm", (state) => {
    const last = state.messages[state.messages.length - 1];
    if (last.content.includes("CLARIFICATION_NEEDED")) return "clarify"; // PRIORIDAD 1
    if (last.tool_calls?.length) return "tools_pm"; 
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

workflow.addEdge("human_node", END); 

// Compilación CON MEMORIA
const app = workflow.compile({ checkpointer });

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

// Función de ejecución (Stream)
async function runAgentProcess(thread_id, inputConfig) {
    try {
        const config = { configurable: { thread_id } };
        
        const stream = await app.stream(inputConfig, { 
            ...config,
            streamMode: "updates"
        });

        for await (const chunk of stream) {
            const nodeName = Object.keys(chunk)[0];
            const update = chunk[nodeName];
            
            // Actualizar estado frontend
            const currentFrontendState = globalFrontendState.get(thread_id) || {};

            // Logs acumulativos
            if (update.log && Array.isArray(update.log)) {
                const existingLogs = currentFrontendState.log || [];
                currentFrontendState.log = [...existingLogs, ...update.log];
            }
            
            // Estado de la UI
            if (update.status) {
                currentFrontendState.status = update.status;
                if (update.question) currentFrontendState.question = update.question;
            } else {
                // IMPORTANTE: No sobrescribir "waiting_for_human" con "running" si el stream 
                // sigue emitiendo pero ya estamos esperando.
                if (currentFrontendState.status !== "waiting_for_human") {
                    currentFrontendState.status = "running";
                }
            }

            globalFrontendState.set(thread_id, currentFrontendState);
        }

    } catch (e) {
        console.error("Error en stream:", e);
        const currentFrontendState = globalFrontendState.get(thread_id) || {};
        currentFrontendState.status = "error";
        currentFrontendState.log = [...(currentFrontendState.log || []), `**Error Crítico**: ${e.message}`];
        globalFrontendState.set(thread_id, currentFrontendState);
    }
}

expressApp.post('/start_run', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Falta el prompt" });

    const thread_id = `thread_${Date.now()}`;
    const initialLog = {
        log: [`**Sistema**: Conectando con Sofía (PM)...`],
        status: "running"
    };
    
    globalFrontendState.set(thread_id, initialLog);

    runAgentProcess(thread_id, { messages: [new HumanMessage(prompt)] });

    res.json({ thread_id });
});

expressApp.get('/get_status/:thread_id', (req, res) => {
    const state = globalFrontendState.get(req.params.thread_id);
    if (state && state.log) {
        state.log = [...new Set(state.log)];
    }
    state ? res.json(state) : res.status(404).json({ error: "Not found" });
});

expressApp.post('/respond', (req, res) => {
    console.log("Solicitud recibida en /respond:", req.body);

    const { thread_id, response } = req.body;
    
    if (!thread_id) return res.status(400).json({ error: "thread_id is required" });
    if (!response) return res.status(400).json({ error: "response is required" });

    const currentState = globalFrontendState.get(thread_id);
    
    if (!currentState) {
        return res.status(404).json({ error: "Thread expired or server restarted. Please reload." });
    }

    currentState.status = "running";
    currentState.log.push(`**Humano**: ${response}`);
    globalFrontendState.set(thread_id, currentState);
    
    runAgentProcess(thread_id, { messages: [new HumanMessage(response)] });
    
    res.json({ status: "resumed" });
});

expressApp.listen(port, '0.0.0.0', () => {
    console.log(`--- Server running on port ${port} ---`);
    console.log(`--- MEMORY ENABLED | MODEL: ${MODEL_NAME} ---`);
});