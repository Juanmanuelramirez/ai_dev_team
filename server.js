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
    description: "Escribe un archivo en el sistema (código, documentación, md). Entrada: file_path (ruta relativa) y content.",
    schema: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Ruta relativa, ej: 'docs/requirements.md' o 'src/index.html'" },
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
// Usamos el modelo que sabemos que funciona
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

const PM_PROMPT = `Eres "Sofía", la Project Manager y Analista de Negocios (BA).
Tu objetivo es entender al usuario y definir el proyecto.

**REGLA DE ORO DE CLARIFICACIÓN:**
1. Analiza la solicitud del usuario. ¿Es vaga? (Ej: "Haz una web", "Quiero un juego").
2. Si faltan detalles críticos (Tecnología, Propósito, Funcionalidades clave), **DETENTE**.
3. NO asumas. Responde ÚNICAMENTE con el formato: "CLARIFICATION_NEEDED: [Tu pregunta clara aquí]".
4. Solo si el requerimiento es claro, procede.

**SI EL REQUERIMIENTO ES CLARO:**
1. Crea un archivo llamado 'documentacion/requerimientos.md' usando la herramienta 'file_write'.
2. En ese archivo, escribe el PRD (Product Requirement Document) detallado.
3. Al final, da paso al Arquitecto.`;

const ARCHITECT_PROMPT = `Eres "Mateo", el Arquitecto de Software.
Recibes los requerimientos de Sofía.

**TUS TAREAS:**
1. Define la estructura técnica del proyecto.
2. Crea un archivo llamado 'documentacion/arquitectura.md' usando la herramienta 'file_write'.
3. En ese archivo incluye:
   - Estructura de carpetas.
   - Stack tecnológico elegido.
   - Diagrama de flujo (en texto/mermaid).
4. Da paso al Desarrollador con instrucciones claras.`;

const DEVELOPER_PROMPT = `Eres "Lucas", el Desarrollador Senior.
Recibes la arquitectura de Mateo.

**TUS TAREAS:**
1. Escribir el código real del proyecto.
2. Usa la herramienta 'file_write' para crear CADA archivo (HTML, CSS, JS, etc.) definido en la arquitectura.
3. No simules, crea los archivos reales.
4. Cuando termines todo, responde "PROJECT_COMPLETED".`;

// ---------------------------------
// 5. Nodos
// ---------------------------------

const createAgentNode = (rolePrompt, tools) => async (state) => {
    const messages = state.messages;
    const systemMessage = new SystemMessage(rolePrompt);
    const modelWithTools = model.bindTools(tools);
    
    const aiResponse = await modelWithTools.invoke([systemMessage, ...messages]);
    
    // --- LOGICA DE IDENTIDAD ---
    // Extraemos el nombre entre comillas del prompt (ej: Eres "Sofía")
    const agentNameMatch = rolePrompt.match(/"([^"]+)"/);
    const agentName = agentNameMatch ? agentNameMatch[1] : "Agente";

    // --- SANITIZACIÓN DE LOGS ---
    let cleanContent = aiResponse.content;
    if (!cleanContent || typeof cleanContent !== 'string') {
        if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
            cleanContent = `*(Solicitando crear archivo/buscar...)*`;
        } else {
            cleanContent = "";
        }
    }

    const logEntry = `**${agentName}**: ${cleanContent}`;
    
    return { messages: [aiResponse], log: [logEntry] };
};

const loggingToolNode = async (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage.tool_calls?.length) return { log: ["**Sistema**: Error interno en herramientas."] };

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
        
        // Si es file_write, el frontend lo capturará para el Canvas.
        // Mostramos un log amigable.
        let logMsg = output;
        if (toolCall.name === 'file_write') {
            const args = toolCall.args;
            logMsg = `Creando archivo: ${args.file_path}`;
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
    // Aquí aseguramos que el log venga del PM (Sofía)
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

// AHORA TODOS LOS AGENTES TIENEN ACCESO A fileWriteTool PARA DOCUMENTAR
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

// Rutas condicionales también para PM y Arquitecto (por si necesitan tools)
// Simplificación: Si PM/Architect llaman tools, van a tool_node y vuelven a sí mismos
// Para esta demo, asumiremos flujo lineal, pero añadiremos el retorno de tools al nodo correspondiente
// (Esto requeriría lógica más compleja de routing, por ahora tools -> developer es el flujo principal, 
//  pero para documentación simple permitimos que pasen al siguiente nodo tras escribir).

// Hack para permitir que PM/Architect escriban archivos sin romper el flujo lineal simple:
// En este diseño simple, si PM llama a tool, LangGraph iría a tool_node. 
// Necesitamos bordes condicionales globales o específicos.
// Para no complicar el grafo, asignaremos que tool_node siempre devuelva al Developer 
// OJO: Esto es una limitación de este diseño simple. 
// CORRECCIÓN: Vamos a permitir que PM y Architect usen tools y sigan adelante.

// Definición de ramas para PM
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

// Definición de ramas para Architect
workflow.addConditionalEdges("architect", (state) => {
    const last = state.messages[state.messages.length - 1];
    if (last.tool_calls?.length) return "tools_arch";
    return "developer";
}, {
    "tools_arch": "tool_node",
    "developer": "developer"
});

// El nodo de herramientas debe saber a quién devolver el control. 
// En LangGraph simple esto es complejo sin memoria de "quién llamó".
// SOLUCIÓN PRÁCTICA: Haremos que tool_node devuelva al 'developer' por defecto, 
// PERO como PM y Architect solo escriben documentación una vez y pasan turno,
// podemos instruirlos para que NO esperen respuesta de la herramienta, sino que asuman éxito.
// Sin embargo, la forma correcta en LangGraph es tener nodos de herramientas separados o memoria.
// Para mantener este archivo simple y funcional:
// Enviaremos el output de la herramienta al siguiente agente lógico.
// PM -> Escribe Archivo -> (Tool Node) -> Architect
// Architect -> Escribe Archivo -> (Tool Node) -> Developer

// Re-enrutamiento dinámico desde tool_node (Simplificación inteligente)
// Si el último mensaje de herramienta fue 'requerimientos.md', vamos a Architect.
// Si fue 'arquitectura.md', vamos a Developer.
// Si fue código, volvemos a Developer.

workflow.addConditionalEdges("tool_node", (state) => {
    const lastToolMsg = state.messages[state.messages.length - 1];
    const content = lastToolMsg.content; // Es el JSON string de salida
    
    if (content.includes("requerimientos.md")) return "architect";
    if (content.includes("arquitectura.md")) return "developer";
    
    return "developer"; // Default loop para el developer creando múltiples archivos
}, {
    "architect": "architect",
    "developer": "developer"
});

// Retorno del humano (siempre vuelve al PM para re-analizar la respuesta)
workflow.addEdge("human_node", "pm"); 

const app = workflow.compile();

// ---------------------------------
// 7. Backend Express (IGUAL QUE ANTES)
// ---------------------------------

const expressApp = express();
const port = process.env.PORT || 8000;

expressApp.use(cors());
expressApp.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
expressApp.use(express.static(path.join(__dirname, 'public')));

expressApp.get('/favicon.ico', (req, res) => res.status(204).end());

async function runAgentProcess(thread_id, inputConfig) {
    try {
        const stream = await app.stream(inputConfig, { 
            configurable: { thread_id },
            streamMode: "updates"
        });

        for await (const chunk of stream) {
            const nodeName = Object.keys(chunk)[0];
            const update = chunk[nodeName];
            const currentState = globalState.get(thread_id);
            if (!currentState) break;

            if (update.log && Array.isArray(update.log)) {
                currentState.log.push(...update.log);
            }
            
            if (update.status) {
                currentState.status = update.status;
                if (update.question) currentState.question = update.question;
            } else {
                currentState.status = "running";
            }
            globalState.set(thread_id, currentState);
        }

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
    const initialState = {
        messages: [new HumanMessage(prompt)],
        log: [`**Sistema**: Iniciando equipo con modelo ${MODEL_NAME}...`]
    };
    
    globalState.set(thread_id, { ...initialState, status: "running" });
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

    currentState.status = "running";
    currentState.log.push(`**Humano**: ${response}`);
    
    runAgentProcess(thread_id, { messages: [new HumanMessage(response)] });
    res.json({ status: "resumed" });
});

expressApp.listen(port, '0.0.0.0', () => {
    console.log(`--- Server running on port ${port} ---`);
    console.log(`--- MODE: Streaming & Clarification Enabled | MODEL: ${MODEL_NAME} ---`);
});