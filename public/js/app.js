// --- URL RELATIVA PARA PRODUCCIÓN (IMPORTANTE) ---
const API_URL = ""; 
        
let translations = {};
let currentLang = "en";
let i18n = {};

let currentThreadId = null;
let pollingInterval = null;
let lastLogCount = 0;

// --- ESTADO DEL PROYECTO ---
let projectFiles = {}; 
let currentFile = null; 

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

const fileExplorer = document.getElementById('file-explorer');
const codeViewer = document.getElementById('code-viewer').querySelector('code');
const currentFilePath = document.getElementById('current-file-path');
const downloadFileButton = document.getElementById('download-file-button');

// --- Internacionalización (i18n) ---
async function loadTranslations() {
    try {
        const response = await fetch('/data/translations.json');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
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
            if (el.tagName === 'TITLE') el.innerText = i18n[key];
            else if (el.placeholder !== undefined) el.placeholder = i18n[key];
            else el.innerText = i18n[key];
        }
    });
}

// --- Funciones Visuales ---
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

function setStatusLoading() {
    spinner.classList.remove('hidden');
    humanInputContainer.classList.add('hidden');
    finishedMessage.classList.add('hidden');
    startButton.disabled = true;
    promptInput.disabled = true;
}

function setStatusError() {
    // Lucas: Nuevo estado para errores. No borra el log, solo restaura controles.
    spinner.classList.add('hidden');
    startContainer.classList.remove('hidden');
    startButton.disabled = false;
    promptInput.disabled = false;
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
    // Lucas: Corregido para ocultar spinner si estaba activo
    spinner.classList.add('hidden'); 
    startContainer.classList.remove('hidden');
    startButton.disabled = false;
    promptInput.disabled = false;
    finishedMessage.classList.add('hidden');
    
    logContainer.innerHTML = '';
    addLogMessage(i18n.waitingForProject || "Esperando...", 'system');
    
    projectFiles = {};
    currentFile = null;
    fileExplorer.innerHTML = `<p class="text-gray-400 italic" data-i18n-key="fileExplorerEmpty">...</p>`;
    codeViewer.textContent = '';
    currentFilePath.textContent = '...';
    downloadFileButton.classList.add('hidden');
    downloadZipButton.classList.add('hidden');
    
    currentThreadId = null;
    lastLogCount = 0;
}

// --- Explorador de Archivos ---
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
                currentLevel[part] = { __isLeaf: true, path: path };
            } else {
                if (!currentLevel[part]) currentLevel[part] = {};
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
            html += renderTreeHTML(item);
        } else {
            const path = item.path;
            const activeClass = (path === currentFile) ? 'active-file' : '';
            html += `<span class="file-tree-item file-item ${activeClass}" onclick="showFileContent('${path}')">${getFileTreeIcon(false)} ${key}</span>`;
        }
        html += '</li>';
    });
    html += '</ul>';
    return html;
}

function renderFileExplorer() {
    if (Object.keys(projectFiles).length === 0) {
        fileExplorer.innerHTML = `<p class="text-gray-400 italic">Vacío</p>`;
        return;
    }
    fileExplorer.innerHTML = renderTreeHTML(buildFileTree(projectFiles));
    downloadZipButton.classList.remove('hidden');
}

function showFileContent(path) {
    currentFile = path;
    codeViewer.textContent = projectFiles[path]; 
    currentFilePath.textContent = path;
    downloadFileButton.classList.remove('hidden');
    document.querySelectorAll('.file-tree-item.active-file').forEach(el => el.classList.remove('active-file'));
    document.querySelector(`.file-tree-item[onclick="showFileContent('${path}')"]`).classList.add('active-file');
}

// --- Descargas ---
function downloadCurrentFile() {
    if (!currentFile) return;
    saveAs(new Blob([projectFiles[currentFile]], { type: "text/plain;charset=utf-8" }), currentFile.split('/').pop()); 
}

async function downloadProjectAsZip() {
    if (Object.keys(projectFiles).length === 0) return;
    const zip = new JSZip();
    Object.keys(projectFiles).forEach(path => zip.file(path, projectFiles[path]));
    try { saveAs(await zip.generateAsync({ type: "blob" }), "proyecto_agentes_ai.zip"); } 
    catch (error) { console.error("Error zip:", error); }
}

// --- Log y API ---
function addLogMessage(message, sender, isError = false) {
    const div = document.createElement('div');
    div.classList.add('flex', 'items-start', 'space-x-3', 'mb-4');
    let contentHTML = message.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    
    if (isError) contentHTML = `<span class="text-red-400 font-bold">⚠️ ${contentHTML}</span>`;
    else if (sender.toLowerCase().includes('herramienta')) contentHTML = `<span class="text-cyan-200 text-sm">${contentHTML}</span>`;
    else if (sender.toLowerCase().includes('humano')) contentHTML = `<span class="text-green-200">${contentHTML}</span>`;

    div.innerHTML = `
        <div class="flex-shrink-0">${getIcon(sender)}</div>
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
        logEntries.slice(lastLogCount).forEach(entry => {
            const parts = entry.split(/:\s(.*)/s);
            let sender = "Sistema", message = entry;
            if (parts.length > 1) { sender = parts[0].replace(/\*/g, ''); message = parts[1].trim(); }
            
            if (sender.toLowerCase() === 'herramienta (file_write)') {
                try {
                    const fd = JSON.parse(message);
                    if (fd.status === "file_created") {
                        projectFiles[fd.path] = fd.content;
                        renderFileExplorer();
                        message = `Archivo escrito en ${fd.path}`;
                    } else message = `Error archivo: ${fd.message}`;
                } catch (e) {}
            }
            addLogMessage(message, sender);
        });
        lastLogCount = logEntries.length;
    }
}

// --- Funciones Core ---
async function startRun() {
    const prompt = promptInput.value;
    if (!prompt) { alert("Describe el proyecto primero"); return; }

    logContainer.innerHTML = '';
    addLogMessage(prompt, "Humano (Solicitud)");
    lastLogCount = 1;
    
    setStatusLoading();
    // Lucas: Ocultamos el input explícitamente al iniciar
    startContainer.classList.add('hidden');

    try {
        const response = await fetch(`${API_URL}/start_run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        });
        
        if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);
        
        const data = await response.json();
        currentThreadId = data.thread_id;
        startPolling();

    } catch (error) {
        console.error("Error startRun:", error);
        // Lucas: NO llamamos a resetUI() aquí, para que el usuario pueda leer el error.
        addLogMessage(`Error de conexión: ${error.message}. Verifica que el backend esté corriendo.`, 'Sistema', true);
        setStatusError(); // Restauramos controles pero mantenemos el log de error
    }
}

function startPolling() { stopPolling(); pollingInterval = setInterval(pollStatus, 2000); }
function stopPolling() { if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; } }

async function pollStatus() {
    if (!currentThreadId) return;
    try {
        const response = await fetch(`${API_URL}/get_status/${currentThreadId}`);
        if (!response.ok) throw new Error("Error polling status");
        const state = await response.json();
        updateLog(state.log || []);
        
        if (state.status === "waiting_for_human") setStatusHumanInput(state.question);
        else if (state.status === "finished") setStatusFinished();
        else if (state.status === "error") {
            addLogMessage(`Error Agente: ${state.log[state.log.length-1]}`, 'Sistema', true);
            setStatusError();
            stopPolling();
        } 
    } catch (error) {
        console.error("Error pollStatus:", error);
        // Si el polling falla una vez, no matamos todo, solo logueamos. Si falla mucho, el usuario lo verá.
    }
}

async function sendResponse() {
    const responseText = humanResponseInput.value;
    if (!responseText) return;
    document.getElementById('respond-button').disabled = true;
    setStatusLoading();
    addLogMessage(responseText, "Humano (Respuesta)");
    humanResponseInput.value = '';

    try {
        const response = await fetch(`${API_URL}/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ thread_id: currentThreadId, response: responseText })
        });
        if (!response.ok) throw new Error("Error enviando respuesta");
        const data = await response.json();
        if (data.status === "resumed") startPolling();
        else throw new Error(data.message);
    } catch (error) {
        addLogMessage(`Error: ${error.message}`, 'Sistema', true);
        setStatusHumanInput("Error. Reintenta.");
    }
}
        
document.addEventListener('DOMContentLoaded', async () => {
    await loadTranslations();
    setLanguage();
    addLogMessage(i18n.waitingForProject || "Esperando...", 'Sistema');
});

window.startRun = startRun;
window.sendResponse = sendResponse;
window.resetUI = resetUI;
window.showFileContent = showFileContent;
window.downloadCurrentFile = downloadCurrentFile;
window.downloadProjectAsZip = downloadProjectAsZip;