import express from 'express';
// ... (imports existentes)
import { fileURLToPath } from 'url';
import path from 'path';

// --- Configuración de API Keys ---
// ... (sin cambios)

// ---------------------------------
// 1. Definición de Herramientas (Tools)
// ---------------------------------
// ... (googleSearchTool, fileReadTool, runTerminalCommandTool sin cambios)

const fileWriteTool = tool(async ({ file_path, content }) => {
    try {
        // La simulación de escritura en el servidor sigue siendo útil para el log
        await fs.mkdir(path.dirname(file_path), { recursive: true });
        await fs.writeFile(file_path, content, 'utf-8');
        
        // ¡CAMBIO CRUCIAL!
        // Devolvemos un JSON que el frontend pueda interceptar.
        // Esto le dice al frontend "¡Creé un archivo!"
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
    description: "Escribe o sobrescribe un archivo con el contenido dado.",
    schema: {
        type: "object",
        properties: {
            file_path: { type: "string" },
            content: { type: "string" },
        },
        required: ["file_path", "content"],
    },
});

const tools = [googleSearchTool, fileWriteTool, fileReadTool, runTerminalCommandTool];

// ... (El resto del archivo: Estado, Nodos de Agente, Prompts, Grafo, App Express)
// ... (loggingToolNode ya maneja la salida de la herramienta y la pone en el log)
// ... (Toda la lógica de 'createAgentNode', 'nodo_humano_en_espera', 'workflow', etc.)
// ... (No se necesitan más cambios en el backend)

// ---------------------------------
// 6. Definición del Backend Express
// ---------------------------------
const app = express();
const port = 8000;

// ... (app.use(cors), app.use(express.json), etc. sin cambios)

// Servir archivos estáticos de la carpeta 'public'
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ... (Todos los endpoints de API: /start_run, /get_status, /respond sin cambios)
// ... (app.listen sin cambios)