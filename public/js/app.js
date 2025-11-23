// --- CORRECCIÓN LUCAS (Tech Lead) ---
// Error anterior: const API_URL = "http://127.0.0.1:8000";
// Causa: Esto obligaba al navegador a buscar el backend en la PC del usuario, fallando en AWS.
// Solución: Usar ruta relativa ("") o "/" para que use el dominio actual automáticamente.
const API_URL = ""; 
        
let translations = {};
let currentLang = "en";
let i18n = {};

let currentThreadId = null;
let pollingInterval = null;
let lastLogCount = 0;

// --- NUEVO ESTADO DEL PROYECTO ---
let projectFiles = {}; // Almacena el contenido de los archivos: { "path/to/file.txt": "content..." }
let currentFile = null; // Ruta del archivo que se está viendo

// Elementos de la UI
const logContainer = document.getElementById('log-container');
const startContainer = document.getElementById('start-container');
const startButton = document.getElementById('start-button');
const promptInput = document.getElementById('prompt-input');
const humanInputContainer = document.getElementById('human-input-container');
const humanQuestionText = document.getElementById('human-question-text');
const humanResponseInput = document.getElementById('human-response-input');
const spinner = document.getElementById('spinner');
const finishedMessage = document.getElementById('finished-message');
const downloadZipButton = document.getElementById('download-zip-button');

// Nuevos elementos de la UI
const fileExplorer = document.getElementById('file-explorer');
const codeViewer = document.getElementById('code-viewer').querySelector('code');
const currentFilePath = document.getElementById('current-file-path');
const downloadFileButton = document.getElementById('download-file-button');

// --- Internacionalización (i18n) ---
async function loadTranslations() {
    try {
        const response = await fetch('/data/translations.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        translations = await response.json();
    } catch (error) {
        console.error("Error cargando traducciones:", error);
        translations = {
            "en": { "metaTitle": "AI Team Interface (Error)" },
            "es": { "metaTitle": "Interfaz del Equipo AI (Error)" }
        };
    }
}

function setLanguage() {
    const browserLang = navigator.language || navigator.userLanguage;
    if (browserLang.startsWith('es') && translations.es) {
        currentLang = 'es';
    } else {
        currentLang = 'en';
    }
    i18n = translations[currentLang];
    document.documentElement.lang = currentLang;

    document.querySelectorAll('[data-i18n-key]').forEach(el => {
        const key = el.getAttribute('data-i18n-key');
        if (key && i18n[key]) {
            if (el.tagName === 'TITLE') {
                el.innerText = i18n[key];
            } else if (el.placeholder !== undefined) {
                el.placeholder = i18n[key];
            } else {
                el.innerText = i18n[key];
            }
        }
    });
}

// --- Funciones de Iconos (Log) ---
function getIcon(sender) {
    let iconId, colorClass;
    if (sender.toLowerCase().includes('humano')) {
        iconId = 'icon-human';
        colorClass = 'text-green-400';
    } else if (sender.toLowerCase().includes('herramienta')) {
        iconId = 'icon-tool';
        colorClass = 'text-cyan-400';
    } else {
        iconId = 'icon-agent';
        colorClass = 'text-indigo-400';
    }
    const svg = document.getElementById(iconId).cloneNode(true);
    svg.setAttribute('id', '');
    svg.classList.add(colorClass);
    return svg.outerHTML;
}

// --- Funciones de Estado de UI ---
function setStatusLoading() {
    spinner.classList.remove('hidden');
    humanInputContainer.classList.add('hidden');
    finishedMessage.classList.add('hidden');
    startButton.disabled = true;
    promptInput.disabled = true;
}

function setStatusHumanInput(question) {
    spinner.classList.add('hidden');
    humanQuestionText.innerText = question;
    humanInputContainer.classList.remove('hidden');
    finishedMessage.classList.add('hidden');
    document.getElementById('respond-button').disabled = false;
    humanResponseInput.focus();
    stopPolling();
}
        
function setStatusFinished() {
    spinner.classList.add('hidden');
    humanInputContainer.classList.add('hidden');
    startContainer.classList.add('hidden');
    finishedMessage.classList.remove('hidden');
    stopPolling();
}

function resetUI() {
    startContainer.classList.remove('hidden');
    startButton.disabled = false;
    promptInput.disabled = false;
    finishedMessage.classList.add('hidden');
    logContainer.innerHTML = '';
    addLogMessage(i18n.waitingForProject, 'system');
    
    // Limpiar nuevo estado
    projectFiles = {};
    currentFile = null;
    fileExplorer.innerHTML = `<p class="text-gray-400 italic" data-i18n-key="fileExplorerEmpty">${i18n.fileExplorerEmpty}</p>`;
    codeViewer.textContent = '';
    currentFilePath.textContent = i18n.codeViewerEmpty;
    downloadFileButton.classList.add('hidden');
    downloadZipButton.classList.add('hidden');
    
    currentThreadId = null;
    lastLogCount = 0;
}

// --- LÓGICA DEL EXPLORADOR DE ARCHIVOS ---

function getFileTreeIcon(isFolder) {
    const iconId = isFolder ? 'icon-folder' : 'icon-file';
    const svg = document.getElementById(iconId).cloneNode(true);
    svg.setAttribute('id', '');
    svg.classList.add(isFolder ? 'icon-folder' : 'icon-file');
    return svg.outerHTML;
}

function buildFileTree(files) {
    const tree = {};
    Object.keys(files).forEach(path => {
        let currentLevel = tree;
        const parts = path.split('/');
        parts.forEach((part, index) => {
            if (index === parts.length - 1) {
                // Es un archivo
                currentLevel[part] = { __isLeaf: true, path: path };
            } else {
                // Es una carpeta
                if (!currentLevel[part]) {
                    currentLevel[part] = {};
                }
                currentLevel = currentLevel[part];
            }
        });
    });
    return tree;
}

function renderTreeHTML(node) {
    let html = '<ul>';
    Object.keys(node).sort().forEach(key => {
        if (key === '__isLeaf') return;

        const item = node[key];
        const isFolder = !item.__isLeaf;
        
        html += '<li>';
        if (isFolder) {
            html += `<span class="file-tree-item folder-item">${getFileTreeIcon(true)} ${key}</span>`;
            html += renderTreeHTML(item); // Recursión
        } else {
            // Es un archivo (item = { __isLeaf: true, path: '...' })
            const path = item.path;
            const activeClass = (path === currentFile) ? 'active-file' : '';
            html += `<span class="file-tree-item file-item ${activeClass}" onclick="showFileContent('${path}')">
                        ${getFileTreeIcon(false)} ${key}
                     </span>`;
        }
        html += '</li>';
    });
    html += '</ul>';
    return html;
}

function renderFileExplorer() {
    if (Object.keys(projectFiles).length === 0) {
        fileExplorer.innerHTML = `<p class="text-gray-400 italic" data-i18n-key="fileExplorerEmpty">${i18n.fileExplorerEmpty}</p>`;
        return;
    }
    const fileTree = buildFileTree(projectFiles);
    fileExplorer.innerHTML = renderTreeHTML(fileTree);
    downloadZipButton.classList.remove('hidden');
}

function showFileContent(path) {
    currentFile = path;
    const content = projectFiles[path];
    codeViewer.textContent = content; 
    currentFilePath.textContent = path;
    downloadFileButton.classList.remove('hidden');
    
    document.querySelectorAll('.file-tree-item.active-file').forEach(el => el.classList.remove('active-file'));
    document.querySelector(`.file-tree-item[onclick="showFileContent('${path}')"]`).classList.add('active-file');
}

// --- LÓGICA DE DESCARGA ---

function downloadCurrentFile() {
    if (!currentFile) return;
    const content = projectFiles[currentFile];
    const filename = currentFile.split('/').pop();
    
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    saveAs(blob, filename); 
}

async function downloadProjectAsZip() {
    if (Object.keys(projectFiles).length === 0) return;
    
    const zip = new JSZip();
    Object.keys(projectFiles).forEach(path => {
        zip.file(path, projectFiles[path]);
    });

    try {
        const content = await zip.generateAsync({ type: "blob" });
        saveAs(content, "proyecto_agentes_ai.zip"); 
    } catch (error) {
        console.error("Error al crear el zip:", error);
    }
}

// --- Lógica de Log y API ---

function addLogMessage(message, sender, isError = false) {
    const div = document.createElement('div');
    div.classList.add('flex', 'items-start', 'space-x-3', 'mb-4');

    const iconHTML = getIcon(sender);
    
    let contentHTML = message
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

    if (isError) {
        contentHTML = `<span class="text-red-400">${contentHTML}</span>`;
    } else if (sender.toLowerCase().includes('herramienta')) {
        contentHTML = `<span class="text-cyan-200 text-sm">${contentHTML}</span>`;
    } else if (sender.toLowerCase().includes('humano')) {
        contentHTML = `<span class="text-green-200">${contentHTML}</span>`;
    }

    div.innerHTML = `
        <div class="flex-shrink-0">${iconHTML}</div>
        <div class="flex-grow">
            <strong class="text-sm ${sender.toLowerCase().includes('humano') ? 'text-green-400' : 'text-gray-300'}">${sender}</strong>
            <p class="text-sm text-gray-100 mt-1">${contentHTML}</p>
        </div>
    `;
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
}

function updateLog(logEntries) {
    if (logEntries.length > lastLogCount) {
        const newEntries = logEntries.slice(lastLogCount);
        newEntries.forEach(entry => {
            const parts = entry.split(/:\s(.*)/s);
            let sender = "Sistema";
            let message = entry;

            if (parts.length > 1) {
                sender = parts[0].replace(/\*/g, '');
                message = parts[1].trim();
            }
            
            if (sender.toLowerCase() === 'herramienta (file_write)') {
                try {
                    const fileData = JSON.parse(message);
                    if (fileData.status === "file_created") {
                        projectFiles[fileData.path] = fileData.content;
                        renderFileExplorer();
                        message = `Archivo escrito en ${fileData.path} (${fileData.content.length} bytes)`;
                    } else {
                        message = `Error al escribir archivo: ${fileData.message}`;
                    }
                } catch (e) {
                    // Fallback
                }
            }

            addLogMessage(message, sender);
        });
        lastLogCount = logEntries.length;
    }
}

// --- Funciones de API ---
async function startRun() {
    const prompt = promptInput.value;
    if (!prompt) {
        alert(i18n.alertEmptyPrompt);
        return;
    }

    logContainer.innerHTML = '';
    addLogMessage(prompt, "Humano (Solicitud)");
    lastLogCount = 1;
    setStatusLoading();
    startContainer.classList.add('hidden');

    try {
        // CORRECCIÓN LUCAS: API_URL ahora es relativo, funcionará en producción.
        const response = await fetch(`${API_URL}/start_run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        });
        
        if (!response.ok) throw new Error(i18n.errorStartServer);
        
        const data = await response.json();
        currentThreadId = data.thread_id;
        startPolling();

    } catch (error) {
        console.error("Error en startRun:", error);
        addLogMessage(`${i18n.errorContactBackend}: ${error.message}`, 'Sistema', true);
        resetUI();
    }
}

function startPolling() {
    stopPolling();
    pollingInterval = setInterval(pollStatus, 2000);
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

async function pollStatus() {
    if (!currentThreadId) return;

    try {
        const response = await fetch(`${API_URL}/get_status/${currentThreadId}`);
        if (!response.ok) throw new Error(i18n.errorGetStatus);

        const state = await response.json();
        updateLog(state.log || []);

        if (state.status === "waiting_for_human") {
            setStatusHumanInput(state.question);
        } else if (state.status === "finished") {
            setStatusFinished();
        } else if (state.status === "error") {
            addLogMessage(`${i18n.errorGraph}: ${state.log[state.log.length-1]}`, 'Sistema', true);
            resetUI();
            stopPolling();
        } else {
            setStatusLoading();
        }

    } catch (error) {
        console.error("Error en pollStatus:", error);
        addLogMessage(`${i18n.errorConnection}: ${error.message}`, 'Sistema', true);
        stopPolling();
        resetUI();
    }
}

async function sendResponse() {
    const responseText = humanResponseInput.value;
    if (!responseText) {
        alert(i18n.alertEmptyResponse);
        return;
    }

    document.getElementById('respond-button').disabled = true;
    setStatusLoading();
    addLogMessage(responseText, "Humano (Respuesta)");
    humanResponseInput.value = '';

    try {
        const response = await fetch(`${API_URL}/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                thread_id: currentThreadId,
                response: responseText
            })
        });

        if (!response.ok) throw new Error(i18n.errorSendResponse);
        const data = await response.json();
        
        if (data.status === "resumed") {
            startPolling();
        } else {
            throw new Error(data.message || i18n.errorResume);
        }

    } catch (error) {
        console.error("Error en sendResponse:", error);
        addLogMessage(`${i18n.errorSendResponse}: ${error.message}`, 'Sistema', true);
        setStatusHumanInput("Hubo un error. Por favor, reintenta tu respuesta.");
    }
}
        
document.addEventListener('DOMContentLoaded', async () => {
    await loadTranslations();
    setLanguage();
    addLogMessage(i18n.waitingForProject, 'Sistema');
});

window.startRun = startRun;
window.sendResponse = sendResponse;
window.resetUI = resetUI;
window.showFileContent = showFileContent;
window.downloadCurrentFile = downloadCurrentFile;
window.downloadProjectAsZip = downloadProjectAsZip;