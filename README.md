# **Proyecto "Equipo de Desarrollo AI" / AI Development Team Project**

## **Español**

Este es un proyecto de aplicación web que implementa un equipo de agentes de IA multi-agente (estilo "MetaGPT") para el desarrollo de software. La aplicación proporciona una interfaz de usuario interactiva para iniciar el proyecto, ver el trabajo de los agentes en tiempo real y recibir el código fuente generado.

La interfaz de usuario no es solo un log; actúa como un mini-IDE donde puedes ver la estructura de archivos que los agentes están creando, hacer clic para ver el contenido del código y descargar el proyecto completo como un archivo `.zip`.

## **English**

This is a web application project that implements a multi-agent AI team (in the style of "MetaGPT") for software development. The application provides an interactive user interface to start the project, watch the agents' work in real-time, and receive the generated source code.

The user interface is not just a log; it acts as a mini-IDE where you can see the file structure the agents are creating, click to view code content, and download the entire project as a `.zip` file.

## **Características / Features**

* **Equipo Multi-Agente:** Implementa un flujo de trabajo de desarrollo (PM, Analista, Arquitecto, UI/UX, Dev, QA, DevOps) usando LangGraph.js.  
* **Interfaz Interactiva:** Un frontend de 3 columnas que muestra:  
  1. **Explorador de Archivos:** Se construye dinámicamente a medida que el agente "Sofía" escribe archivos.  
  2. **Log de Agentes:** Una transcripción en tiempo real de la "conversación" y el trabajo del equipo.  
  3. **Visor de Código:** Permite seleccionar un archivo del explorador para ver su contenido.  
* **Protocolo de Clarificación:** Los agentes están programados para pausar y pedir clarificación al usuario si los requisitos son ambiguos.  
* **Agnóstico a la Plataforma:** Los prompts de los agentes (en `server.js`) están diseñados para *preguntar* sobre la plataforma (Web, Mobile, Standalone) en lugar de asumirla.  
* **Descarga de Proyecto:** Permite descargar todos los archivos generados como un solo `.zip`.  
* **Internacionalización (i18n):** La interfaz detecta el idioma del navegador (en/es).  
* **Multi-Agent Team:** Implements a development workflow (PM, Analyst, Architect, UI/UX, Dev, QA, DevOps) using LangGraph.js.  
* **Interactive Interface:** A 3-column frontend that displays:  
  1. **File Explorer:** Dynamically built as the "Sofia" agent writes files.  
  2. **Agent Log:** A real-time transcript of the team's "conversation" and work.  
  3. **Code Viewer:** Allows selecting a file from the explorer to view its content.  
* **Clarification Protocol:** Agents are programmed to pause and ask the user for clarification if requirements are ambiguous.  
* **Platform-Agnostic:** The agent prompts (in `server.js`) are designed to *ask* about the platform (Web, Mobile, Standalone) rather than assuming it.  
* **Project Download:** Allows downloading all generated files as a single `.zip`.  
* **Internationalization (i18n):** The interface detects the browser's language (en/es).

  ## **Arquitectura / Architecture**

El proyecto está dividido en dos componentes principales que se ejecutan desde un solo servidor Node.js:

1. **Backend (`server.js`)**  
   * **Servidor API:** Un servidor `Express` que expone una API REST simple (`/start_run`, `/get_status`, `/respond`) para que el frontend la consuma.  
   * **Orquestador de Agentes:** Usa `LangGraph.js` para definir y ejecutar el flujo de trabajo de los agentes de IA.  
   * **Servidor Estático:** Sirve los archivos estáticos del frontend (HTML, CSS, JS) desde la carpeta `public/`.  
2. **Frontend (`public/`)**  
   * **UI:** Una aplicación de una sola página (SPA) construida con HTML, Tailwind CSS y JavaScript vainilla.  
   * **Lógica:** `public/js/app.js` maneja toda la lógica del cliente, including las llamadas API, el polling de estado y la manipulación del DOM para construir el árbol de archivos y el log.

The project is divided into two main components run from a single Node.js server:

1. **Backend (`server.js`)**  
   * **API Server:** An `Express` server that exposes a simple REST API (`/start_run`, `/get_status`, `/respond`) for the frontend to consume.  
   * **Agent Orchestrator:** Uses `LangGraph.js` to define and execute the AI agent workflow.  
   * **Static Server:** Serves the static frontend files (HTML, CSS, JS) from the `public/` folder.  
2. **Frontend (`public/`)**  
   * **UI:** A single-page application (SPA) built with HTML, Tailwind CSS, and vanilla JavaScript.  
   * **Logic:** `public/js/app.js` handles all client-side logic, including API calls, state polling, and DOM manipulation to build the file tree and log.

   ## **Tecnologías Utilizadas / Technologies Used**

* **Backend:** Node.js, Express.js, LangChain.js, LangGraph.js, Google Gemini  
* **Frontend:** HTML5, Tailwind CSS, JavaScript (Vanilla), JSZip, FileSaver.js

  ## **Instalación y Ejecución / Installation and Setup**

Sigue estos pasos para ejecutar el proyecto en tu máquina local. / Follow these steps to run the project on your local machine.

### **1\. Prerrequisitos / Prerequisites**

* [Node.js](https://nodejs.org/) (v18 o superior / v18 or higher)  
* `npm` (incluido con Node.js / included with Node.js)

  ### **2\. Instalación / Installation**

1. Clona este repositorio o descarga los archivos en una carpeta. / Clone this repository or download the files into a folder.  
2. Abre una terminal en la raíz del proyecto (donde se encuentra `package.json`). / Open a terminal in the project root (where `package.json` is located).  
3. Instala las dependencias del backend: / Install the backend dependencies:

```
npm install
```

   ### **3\. Configuración de API Keys (¡Importante\!) / API Key Configuration (Important\!)**

Este proyecto requiere tres claves de API de Google para funcionar. / This project requires three Google API keys to function.

1. Abre el archivo `server.js` en un editor de código. / Open the `server.js` file in a code editor.  
2. Busca la sección `Configuración de API Keys` (cerca de la línea 15). / Find the `Configuración de API Keys` section (near line 15).  
3. Reemplaza los valores de `TU_GEMINI_API_KEY`, `TU_GOOGLE_API_KEY`, y `TU_GOOGLE_CSE_ID` con tus claves reales. / Replace the `TU_GEMINI_API_KEY`, `TU_GOOGLE_API_KEY`, and `TU_GOOGLE_CSE_ID` placeholders with your actual keys.  
   * **`GEMINI_API_KEY`:** Obtén tu clave desde [Google AI Studio](https://aistudio.google.com/app/apikey). / Get your key from [Google AI Studio](https://aistudio.google.com/app/apikey).  
   * **`GOOGLE_API_KEY` y `GOOGLE_CSE_ID`:** Se usan para la herramienta `Google Search` de la agente Ana. / These are used for Ana's `Google Search` tool.  
     1. Habilita la "Custom Search JSON API" en tu Google Cloud Console. / Enable the "Custom Search JSON API" in your Google Cloud Console.  
     2. Crea una clave de API (esa es tu `GOOGLE_API_KEY`). / Create an API key (this is your `GOOGLE_API_KEY`).  
     3. Crea un "Motor de Búsqueda Programable" (CSE) y obtén su ID (ese es tu `GOOGLE_CSE_ID`). / Create a "Programmable Search Engine" (CSE) and get its ID (this is your `GOOGLE_CSE_ID`).

   ### **4\. Ejecución / Running the Application**

1. Una vez instaladas las dependencias y configuradas las claves, inicia el servidor: / Once dependencies are installed and keys are configured, start the server:

```
node server.js
```

2.   
   Tu terminal debería mostrar: / Your terminal should display:

```
--- Servidor Node.js del Equipo de Agentes iniciado en [http://127.0.0.1:8000](http://127.0.0.1:8000) ---
```

3.   
   Abre tu navegador web y ve a: / Open your web browser and go to: [**http://127.0.0.1:8000**](https://www.google.com/search?q=http://127.0.0.1:8000)

¡Ahora puedes interactuar con la aplicación, describir tu proyecto e iniciar el equipo de agentes\! / You can now interact with the application, describe your project, and start the agent team\!

