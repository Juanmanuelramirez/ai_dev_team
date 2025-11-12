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
import { google } from 'googleapis'; // Para la herramienta de búsqueda

// ---------------------------------
// --- Configuración de API Keys ---
// ---------------------------------
// !! IMPORTANTE: Reemplaza con tus claves de API
const GEMINI_API_KEY = "TU_GEMINI_API_KEY"; // De Google AI Studio
const GOOGLE_API_KEY = "TU_GOOGLE_API_KEY"; // De Google Cloud (para Custom Search)
const GOOGLE_CSE_ID = "TU_GOOGLE_CSE_ID"; // De Google Cloud (ID del motor de búsqueda)

if (GEMINI_API_KEY === "TU_GEMINI_API_KEY") {
    console.error("!!! ERROR: Por favor, añade tu GEMINI_API_KEY en server.js (línea 23)");
}

const customsearch = google.customsearch("v1");

// ---------------------------------
// 1. Definición de Herramientas (Tools)
// ---------------------------------

// Herramienta para escribir archivos (¡REAL!)
const fileWriteTool = tool(async ({ file_path, content }) => {
    try {
        const fullPath = path.join(__dirname, 'proyecto_generado', file_path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        
        // ¡Importante! Devolvemos un JSON para el log del frontend
        return JSON.stringify({
            status: "file_created",
            path: file_path, // Devolvemos la ruta relativa para el frontend
            content: content 
        });
    } catch (e) {
        return JSON.stringify({ status: "error", message: `Error al escribir archivo ${file_path}: ${e.message}` });
    }
}, {
    name: "file_write",
    description: "Escribe o sobrescribe un archivo en el directorio 'proyecto_generado' con el contenido dado. Usa rutas relativas (ej. 'src/index.js').",
    schema: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Ruta relativa del archivo (ej. 'index.html')." },
            content: { type: "string", description: "Contenido completo del archivo." },
        },
        required: ["file_path", "content"],
    },
});

// Herramienta de lectura de archivos (Simulada por seguridad, puedes hacerla real)
const fileReadTool = tool(async ({ file_path }) => {
    return JSON.stringify({ status: "error", message: "La lectura de archivos no está implementada en esta demo." });
}, {
    name: "file_read",
    description: "Lee el contenido de un archivo.",
    schema: { /* ... schema ... */ },
});

// Herramienta de terminal (Simulada por seguridad)
const runTerminalCommandTool = tool(async ({ command }) => {
    return JSON.stringify({ status: "error", message: "La ejecución de terminal está deshabilitada." });
}, {
    name: "run_terminal_command",
    description: "Ejecuta un comando de terminal.",
    schema: { /* ... schema ... */ },
});

// Herramienta de Búsqueda de Google (¡REAL!)
const googleSearchTool = tool(async ({ query }) => {
    try {
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
        })).slice(0, 5); // Devolver los primeros 5 resultados
        
        return JSON.stringify(snippets);
    } catch (e) {
        return JSON.stringify({ status: "error", message: `Error en Google Search: ${e.message}` });
    }
}, {
    name: "google_search",
    description: "Busca en Google para obtener información actualizada o investigar tecnologías.",
    schema: {
        type: "object",
        properties: { query: { type: "string", description: "La consulta de búsqueda." } },
        required: ["query"],
    },
});

const allTools = [fileWriteTool, fileReadTool, runTerminalCommandTool, googleSearchTool];

// ---------------------------------
// 2. Definición del Modelo Gemini
// ---------------------------------
const model = new ChatGoogleGenerativeAI({
    apiKey: GEMINI_API_KEY,
    model: "gemini-1.5-flash-latest",
    temperature: 0.7,
});

// ---------------------------------
// 3. Definición del Estado del Grafo
// ---------------------------------

// Este objeto 'globalState' almacenará el estado de cada conversación (hilo)
const globalState = new Map();

// Definición de la estructura del estado de LangGraph
const appState = {
    // 'messages' es la conversación
    messages: {
        value: (a, b) => a.concat(b),
        default: () => [],
    },
    // 'log' es lo que verá el usuario en el frontend
    log: {
        value: (a, b) => a.concat(b),
        default: () => [],
    },
    // 'status' controla la UI (running, waiting_for_human, finished)
    status: {
        value: (a, b) => b,
        default: () => "running",
    },
    // 'question' almacena la pregunta para el humano
    question: {
        value: (a, b) => b,
        default: () => "",
    }
};

// ---------------------------------
// 4. Prompts de los Agentes
// ---------------------------------

const PM_PROMPT = `Eres el "Project Manager" (PM) de un equipo de desarrollo de IA.
Tu trabajo es tomar el prompt inicial del usuario y convertirlo en un plan de acción claro y conciso para el "Arquitecto".
Define los objetivos principales, el stack tecnológico (si se sugiere) y las características clave.
Tu salida debe ser una directiva clara para el Arquitecto. No escribas código.`;

const ARCHITECT_PROMPT = `Eres el "Arquitecto de Software".
Has recibido un plan del PM. Tu trabajo es investigar (usando 'google_search') las mejores tecnologías y estructuras de proyecto.
Define la arquitectura del sistema, las tecnologías a usar (ej. HTML/CSS/JS, React, Node.js) y una estructura de archivos detallada.
Tu salida debe ser un plan técnico para el "Desarrollador".`;

const DEVELOPER_PROMPT = `Eres el "Desarrollador" del equipo.
Has recibido un plan técnico del Arquitecto. Tu trabajo es escribir el código.
Usa la herramienta 'file_write' para crear cada archivo uno por uno.
Piensa paso a paso y escribe el contenido de cada archivo.
Si la solicitud es ambigua o necesitas más detalles, responde con "CLARIFICATION_NEEDED: [tu pregunta aquí]". NO uses la herramienta 'file_write' si necesitas clarificación.
Si has terminado todo el trabajo, responde con "PROJECT_COMPLETED".`;

// ---------------------------------
// 5. Nodos del Grafo (Agentes y Herramientas)
// ---------------------------------

/**
 * Función genérica para crear un nodo de agente
 */
const createAgentNode = (rolePrompt, tools) => async (state) => {
    const messages = state.messages;
    const systemMessage = new SystemMessage(rolePrompt);
    const modelWithTools = model.bindTools(tools);
    
    // Añade el prompt del sistema al historial de mensajes para el modelo
    const aiResponse = await modelWithTools.invoke([systemMessage, ...messages]);
    
    // Añade la respuesta de la IA al log del frontend
    const logEntry = `**${rolePrompt.split('"')[1]}**: ${aiResponse.content}`;
    
    return {
        messages: [aiResponse],
        log: [logEntry],
    };
};

/**
 * Nodo para ejecutar herramientas
 */
const loggingToolNode = async (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) {
        return { log: ["**Error**: El agente intentó usar una herramienta pero no proporcionó tool_calls."] };
    }

    const toolMessages = [];
    const logEntries = [];

    for (const toolCall of lastMessage.tool_calls) {
        const tool = allTools.find(t => t.name === toolCall.name);
        if (!tool) {
            toolMessages.push(new ToolMessage("Herramienta no encontrada", toolCall.id));
            logEntries.push(`**Herramienta (${toolCall.name})**: ERROR: Herramienta no encontrada.`);
            continue;
        }
        
        const output = await tool.invoke(toolCall.args);
        
        // El output ya es un JSON de la herramienta (fileWriteTool o googleSearchTool)
        logEntries.push(`**Herramienta (${toolCall.name})**: ${output}`);
        toolMessages.push(new ToolMessage(output, toolCall.id));
    }

    return {
        messages: toolMessages,
        log: logEntries,
    };
};

/**
 * Nodo para esperar la entrada humana
 */
const humanInputNode = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const question = lastMessage.content.replace("CLARIFICATION_NEEDED:", "").trim();
    
    return {
        status: "waiting_for_human",
        question: question,
        log: [`**Sistema**: El equipo necesita tu ayuda: ${question}`],
    };
};

/**
 * Función de enrutamiento: decide a dónde ir después de un nodo
 */
const routeWork = (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    
    // 1. ¿Llamada a herramienta?
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        return "tools";
    }
    // 2. ¿Necesita clarificación?
    if (lastMessage.content.includes("CLARIFICATION_NEEDED")) {
        return "clarify";
    }
    // 3. ¿Proyecto terminado?
    if (lastMessage.content.includes("PROJECT_COMPLETED")) {
        return "end";
    }
    // 4. Continuar al siguiente agente (si existe)
    return "continue";
};

// ---------------------------------
// 6. Construcción del Grafo (Workflow)
// ---------------------------------

const workflow = new StateGraph({ channels: appState });

// Añadir nodos
workflow.addNode("pm", createAgentNode(PM_PROMPT, []));
workflow.addNode("architect", createAgentNode(ARCHITECT_PROMPT, [googleSearchTool]));
workflow.addNode("developer", createAgentNode(DEVELOPER_PROMPT, [fileWriteTool, fileReadTool, runTerminalCommandTool]));
workflow.addNode("tool_node", loggingToolNode);
workflow.addNode("human_node", humanInputNode);

// Definir el punto de entrada
workflow.setEntryPoint("pm");

// Definir las transiciones (flujo de trabajo)
workflow.addEdge("pm", "architect");
workflow.addEdge("architect", "developer");

// El desarrollador es el nodo más complejo:
workflow.addConditionalEdges("developer", routeWork, {
    "tools": "tool_node",    // Si llama a herramienta, va al nodo de herramientas
    "clarify": "human_node", // Si pide clarificación, va al nodo humano
    "end": END,              // Si termina, finaliza el grafo
    "continue": END          // Si solo habla sin hacer nada, termina (puedes cambiar esto)
});

// El nodo de herramientas siempre devuelve el control al desarrollador
workflow.addEdge("tool_node", "developer");

// El nodo humano también devuelve el control al desarrollador (con la nueva info)
workflow.addEdge("human_node", "developer");

// Compilar el grafo
const app = workflow.compile();

// ---------------------------------
// 7. Definición del Backend Express
// ---------------------------------

const expressApp = express();
const port = 8000;

// --- Middlewares ---
expressApp.use(cors());
expressApp.use(express.json());

// Servir archivos estáticos
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
expressApp.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------
// 8. Endpoints de API (¡REALES!)
// ---------------------------------

// --- Endpoint para INICIAR el run ---
expressApp.post('/start_run', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: "No se proporcionó el prompt" });
    }

    try {
        const thread_id = `thread_${Date.now()}`;
        const initialState = {
            messages: [new HumanMessage(prompt)],
            log: [`**Sistema**: Run iniciado. Prompt: "${prompt}"`]
        };
        
        // Guardar el estado inicial
        globalState.set(thread_id, { ...initialState, status: "running" });

        // Invocar el grafo en segundo plano (para no bloquear la respuesta)
        (async () => {
            try {
                // 'app.invoke' es para un solo paso. 'app.stream' o 'app.invoke' en bucle es mejor
                // Aquí usamos 'app.invoke' para obtener el estado final
                const finalState = await app.invoke(initialState, { configurable: { thread_id } });
                // Actualizar el estado final
                globalState.set(thread_id, { ...finalState, status: "finished", log: [...finalState.log, "**Sistema**: Proyecto completado."] });
            
            } catch (e) {
                console.error("Error durante la ejecución del grafo:", e);
                // Capturar estado de error
                const currentState = globalState.get(thread_id) || initialState;
                globalState.set(thread_id, { 
                    ...currentState, 
                    status: "error", 
                    log: [...currentState.log, `**Sistema**: ERROR GRAVE - ${e.message}`] 
                });
            }
        })();

        res.json({ thread_id: thread_id });

    } catch (e) {
        console.error("Error en /start_run:", e);
        res.status(500).json({ error: "Error interno del servidor al iniciar" });
    }
});

// --- Endpoint para OBTENER ESTADO ---
expressApp.get('/get_status/:thread_id', (req, res) => {
    const { thread_id } = req.params;
    const state = globalState.get(thread_id);

    if (state) {
        res.json(state);
    } else {
        res.status(404).json({ error: "Thread no encontrado" });
    }
});

// --- Endpoint para RESPONDER al agente ---
expressApp.post('/respond', (req, res) => {
    const { thread_id, response } = req.body;
    if (!thread_id || !response) {
        return res.status(400).json({ error: "Faltan thread_id o response" });
    }

    const currentState = globalState.get(thread_id);
    if (!currentState || currentState.status !== "waiting_for_human") {
        return res.status(400).json({ error: "El hilo no está esperando una respuesta humana." });
    }

    // Actualizar el estado y el log con la respuesta humana
    currentState.status = "running";
    currentState.log.push(`**Humano (Respuesta)**: ${response}`);
    
    // Reanudar el grafo en segundo plano
    (async () => {
        try {
            // Pasamos la respuesta humana como un nuevo mensaje
            const finalState = await app.invoke({ messages: [new HumanMessage(response)] }, { configurable: { thread_id } });
            // Actualizar el estado final
            globalState.set(thread_id, { ...finalState, status: "finished", log: [...finalState.log, "**Sistema**: Proyecto completado."] });
        
        } catch (e) {
            console.error("Error durante la reanudación del grafo:", e);
            const currentState = globalState.get(thread_id);
            globalState.set(thread_id, { 
                ...currentState, 
                status: "error", 
                log: [...currentState.log, `**Sistema**: ERROR GRAVE - ${e.message}`] 
            });
        }
    })();

    res.json({ status: "resumed", message: "Respuesta recibida" });
});


// --- Iniciar servidor ---
expressApp.listen(port, '127.0.0.1', () => {
    console.log(`--- Servidor Node.js del Equipo de Agentes iniciado en http://127.0.0.1:${port} ---`);
    console.log("Asegúrate de haber reemplazado TUS_API_KEYS en server.js");
});