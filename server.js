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
// 2. Definición del Modelo Gemini (SINCRONIZADO CON TU OTRO REPO)
// ---------------------------------
// LUCAS: Usamos el modelo EXACTO que funciona en tu proyecto 'agenticai_job'.
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
// 4. Prompts
// ---------------------------------

const PM_PROMPT = `Eres el Project Manager. Define objetivos, stack y características para el Arquitecto. Sé conciso.`;
const ARCHITECT_PROMPT = `Eres el Arquitecto. Investiga y define estructura de archivos y tecnologías. Salida: Plan técnico.`;
const DEVELOPER_PROMPT = `Eres el Desarrollador. Escribe el código usando 'file_write'. Si hay dudas, responde "CLARIFICATION_NEEDED: [duda]". Al finalizar, "PROJECT_COMPLETED".`;

// ---------------------------------
// 5. Nodos
// ---------------------------------

const createAgentNode = (rolePrompt, tools) => async (state) => {
    const messages = state.messages;
    const systemMessage = new SystemMessage(rolePrompt);
    const modelWithTools = model.bindTools(tools);
    const aiResponse = await modelWithTools.invoke([systemMessage, ...messages]);
    const logEntry = `**${rolePrompt.split('.')[0].replace('Eres el ', '')}**: ${aiResponse.content}`; 
    return { messages: [aiResponse], log: [logEntry] };
};

const loggingToolNode = async (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage.tool_calls?.length) return { log: ["**Error**: Intento de uso de herramienta fallido."] };

    const toolMessages = [];
    const logEntries = [];

    for (const toolCall of lastMessage.tool_calls) {
        const tool = allTools.find(t => t.name === toolCall.name);
        if (!tool) {
            toolMessages.push(new ToolMessage("Tool not found", toolCall.id));
            continue;
        }
        const output = await tool.invoke(toolCall.args);
        logEntries.push(`**Herramienta (${toolCall.name})**: Acción ejecutada.`);
        toolMessages.push(new ToolMessage(output, toolCall.id));
    }
    return { messages: toolMessages, log: logEntries };
};

const humanInputNode = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const question = lastMessage.content.replace("CLARIFICATION_NEEDED:", "").trim();
    return { status: "waiting_for_human", question: question, log: [`**Sistema**: Esperando input humano.`] };
};

const routeWork = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage.tool_calls?.length) return "tools";
    if (lastMessage.content.includes("CLARIFICATION_NEEDED")) return "clarify";
    if (lastMessage.content.includes("PROJECT_COMPLETED")) return "end";
    return "continue";
};

// ---------------------------------
// 6. Workflow
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
    "continue": END 
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

expressApp.post('/start_run', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Falta el prompt" });

    const thread_id = `thread_${Date.now()}`;
    const initialState = {
        messages: [new HumanMessage(prompt)],
        log: [`**Sistema**: Iniciando...`]
    };
    globalState.set(thread_id, { ...initialState, status: "running" });

    (async () => {
        try {
            const finalState = await app.invoke(initialState, { configurable: { thread_id } });
            globalState.set(thread_id, { ...finalState, status: "finished", log: [...finalState.log, "**Sistema**: Fin."] });
        } catch (e) {
            console.error(e);
            const current = globalState.get(thread_id);
            globalState.set(thread_id, { ...current, status: "error", log: [...(current?.log || []), `ERROR CRÍTICO: ${e.message}`] });
        }
    })();
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

    currentState.status = "running";
    currentState.log.push(`**Humano**: ${response}`);
    
    (async () => {
        try {
            const finalState = await app.invoke({ messages: [new HumanMessage(response)] }, { configurable: { thread_id } });
            globalState.set(thread_id, { ...finalState, status: "finished", log: [...finalState.log, "**Sistema**: Fin."] });
        } catch (e) {
            const current = globalState.get(thread_id);
            globalState.set(thread_id, { ...current, status: "error", log: [...(current?.log || []), `ERROR CRÍTICO: ${e.message}`] });
        }
    })();
    res.json({ status: "resumed" });
});

expressApp.listen(port, '0.0.0.0', () => {
    console.log(`--- Server running on port ${port} ---`);
    console.log(`--- USANDO MODELO: ${MODEL_NAME} ---`); // Verifica este log al iniciar
});