# Ultra-Accurate Deep Research

Accuracy-first desktop research agent (Electron + React + Vite + Tailwind). Every claim in the final report must trace to a source. Speed is irrelevant — runs may take 30+ minutes.

## Run (dev)

```powershell
npm run dev          # vite only
npm run electron:dev # full desktop app (vite + electron)
```

## Build

```powershell
npm run build     # vite + electron main/preload
npm run build:win # + electron-builder Windows installer (./release)
```

## Setup in app

1. Open **⚙ Settings** → create a **connection profile**:
   - Provider type: `openai-compatible` (`/chat/completions`, OpenRouter/Groq/Together/Ollama/…) or `anthropic-compatible` (`/v1/messages`).
   - Base URL, model ID (free text), context window, temperatures, reasoning toggle (`reasoning_effort` vs `thinking.budget_tokens`).
   - **Test Connection** before use. Optional per-phase profile overrides.
2. Settings → **Web Search**: Tavily or Serper key (+ optional base-URL override).
3. Enter a query, pick the default profile, **Start Deep Research**.

## Pipeline

Phase 1 decomposition → Phase 2 exhaustive retrieval (multi-query, reformulate ≤3, map-reduce over context window) → Phase 3 synthesis (only from context, else "Information not found in sources.") → Phase 4 red-team (`{status: PASS|FAIL, corrections}`) → Phase 5 refine ≤5 → Phase 6 markdown with `[1]…` citations + Sources section.

## Security

- Keys live only in the main process, stored encrypted at rest (`safeStorage`, `~userData/*.enc`), never sent to the renderer. Preload exposes a minimal `window.electronAPI`.
- Base URLs validated as `http(s)`; keys never logged (redacted `***` only).
