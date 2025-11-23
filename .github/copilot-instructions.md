# AI Development Team Project - Copilot Instructions

## Project Overview
This is a multi-agent AI system that orchestrates a team of LLM-powered agents (PM, Architect, Developer, etc.) to autonomously build software projects. The system uses **LangGraph.js** to coordinate agents and includes a real-time web UI showing agent work, generated files, and code output.

### Architecture
- **Backend** (`server.js`): Express API + LangGraph agent orchestrator on port 8000
- **Frontend** (`public/`): Single-page app with 3-column layout—file explorer, agent log, code viewer
- **Technologies**: Node.js, Express, LangChain.js, LangGraph.js, Google Gemini API, vanilla JS + Tailwind CSS

## Critical Data Flows

### 1. Agent Workflow (server.js)
```
PM → Architect → Developer → (tools) → (clarification if needed) → completion
```
**Current Implementation**: PM, Architect, Developer (3 agents)
**Planned Expansion**: README mentions PM, Analyst, Architect, UI/UX, Dev, QA, DevOps—not yet implemented

**How to add agents**:
1. Create new role prompt constant (e.g., `const ANALYST_PROMPT = "..."`)
2. Add node: `workflow.addNode("analyst", createAgentNode(ANALYST_PROMPT, tools))`
3. Insert edge(s) in workflow (e.g., `workflow.addEdge("pm", "analyst")`)
4. Update `routeWork()` if new agent needs conditional routing

- **LangGraph StateGraph** manages this flow with conditional routing (`routeWork` function)
- Agents communicate via message history; each agent gets `[SystemMessage(role_prompt), ...messages]`
- **Key constraint**: Only Developer uses tools (file_write, google_search); PM/Architect are text-only
- Tool outputs are **automatically logged** and parsed by frontend to extract file content

### 2. Frontend ↔ Backend Communication
**Poll-based pattern** (no WebSockets):
- `POST /start_run` → backend spawns agent thread in background, returns `thread_id`
- `GET /get_status/:thread_id` → frontend polls every 2 seconds to retrieve `state.log` entries
- `POST /respond` → when agents ask for clarification (text containing `"CLARIFICATION_NEEDED"`), frontend blocks UI and waits for user input

### 3. File Capture Pipeline
- Developer calls `file_write` tool → tool returns JSON `{status: "file_created", path, content}`
- Frontend intercepts log entries, detects `"**Herramienta (file_write)**"` prefix, parses JSON
- Parsed files populate `projectFiles` object, triggering file tree re-render
- Users can view/download individual files or entire project as `.zip`

## Developer Workflows

### Running the Project
```bash
npm install                    # Install dependencies
# Edit server.js: set GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_CSE_ID (required)
node server.js                 # Starts server on http://127.0.0.1:8000
```
- No build step; pure CommonJS/ES modules loaded dynamically
- Frontend served as static files from `public/`
- Check console for `"Servidor Node.js del Equipo de Agentes iniciado"` confirmation

### Testing Agent Behavior
- Start a run with a simple prompt (e.g., "Create a To-Do app in HTML/JS")
- **Agent clarification** is triggered if prompt lacks platform specifics (Web/Mobile)—agents ask user via `CLARIFICATION_NEEDED: [question]`
- Check browser console and terminal for errors; logs are echoed to both
- File tree updates in real-time as Developer agent calls `file_write`

## Project-Specific Patterns & Conventions

### Agent Prompt Design (server.js lines ~95-105)
- **Agents use "instruction markers"**: `CLARIFICATION_NEEDED` pauses execution; `PROJECT_COMPLETED` signals end
- Prompts are **bilingual-aware** but English-favoring for LLM reasoning
- Architect uses `google_search` to research tech stacks—define via tool binding, not agent instruction
- Developer is the only agent with file I/O access; PM/Architect are "thought" agents

### State Management (server.js appState object)
- `messages`: LangChain message history (HumanMessage, AIMessage, ToolMessage, SystemMessage)
- `log`: Frontend-facing array of formatted strings (e.g., `"**Agent Name**: message"`)
- `status`: One of `"running"`, `"waiting_for_human"`, `"finished"`, `"error"`
- **Per-thread state**: stored in `globalState` Map keyed by `thread_id`; **no persistence** (resets on server restart)

### Frontend i18n (app.js, translations.json)
- Browser language auto-detection; fallback to English
- All UI text is **attribute-based** (`data-i18n-key`), not hardcoded
- Add new keys to `public/data/translations.json` for multi-language support

### File Naming & Paths
- Agent-generated files go to `proyecto_generado/` (on-disk) but are referenced as relative paths in frontend
- All file paths use forward slashes (`/`) for consistency across platforms
- `.zip` download uses JSZip library; ensure FileSaver.js is loaded in index.html

## Integration Points & External Dependencies

### Google APIs (Required for Production)
- **Gemini API** (`google-genai` package): Language model for all agent reasoning
  - Endpoint: `gemini-1.5-flash-latest` (see server.js line 116)
  - **Rate Limiting**: Free tier allows ~60 requests/minute; for heavy testing, implement exponential backoff in `createAgentNode` or cache results
  - Monitor quota errors in terminal; adjust temperature (0.7) or prompt verbosity if hitting limits
- **Custom Search JSON API**: Used by Architect for research (`google_search` tool)
  - Requires both `GOOGLE_API_KEY` and `GOOGLE_CSE_ID` (Programmable Search Engine)
  - Free tier: 100 searches/day; implement caching in `googleSearchTool` if running multiple project generations

### Key Dependencies & Versions
- `@langchain/langgraph`: StateGraph, workflow compilation, message types
- `@langchain/core`: tool(), StateGraph base, message classes
- `@langchain/google-genai`: ChatGoogleGenerativeAI model binding
- `googleapis`: google.customsearch API client
- `express`: HTTP server; CORS enabled globally
- `jszip` + `filesaver.js`: Client-side ZIP generation and download

## Critical Gotchas & Edge Cases

1. **Tool Binding**: Use `model.bindTools(tools)` before invoking agent; unbound models ignore tool calls
2. **Message Types Matter**: LangGraph requires specific message classes (HumanMessage, ToolMessage); plain strings fail
3. **Polling Race Condition**: Frontend polls before Developer finishes first tool call—gracefully handle "no new log entries yet"
4. **File Path Escaping**: Frontend uses eval-style onclick (`onclick="showFileContent('...')"`)—sanitize paths to prevent XSS
5. **Agent Deadlock**: If Developer doesn't emit `PROJECT_COMPLETED` or `CLARIFICATION_NEEDED`, workflow continues to `END` silently; design prompts carefully
6. **No Session Persistence**: Refreshing page loses all progress; entire state is ephemeral

## Common Modifications

- **Add a new agent role**: Create new role prompt (string), add node to workflow, insert edge(s)
- **Add a new tool**: Define via `tool()` function, bind to relevant agent's `modelWithTools`, add to `allTools` array
- **Change polling interval**: Modify `setInterval(pollStatus, 2000)` in app.js (currently 2 seconds)
- **Customize i18n**: Edit `public/data/translations.json`; add new keys and render with `i18n[key]`
