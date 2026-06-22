# CLI-JAW Architecture

Technical overview for contributors. The detailed source-of-truth map lives in
`structure/`; start with `structure/INDEX.md`, then use
`structure/str_func.md`, `structure/server_api.md`, and
`structure/commands.md` for exact counts and route/command surfaces.

This file is intentionally higher level than `structure/` so it can stay useful
in public and submodule-light checkouts.

---

## System Overview

```text
User interfaces
  Web chat UI          public/
  Terminal TUI        bin/commands/chat.ts + src/cli/tui/
  Telegram            src/telegram/
  Discord             src/discord/
  Electron desktop    electron/ + src/manager/

Core server
  server.ts           bootstrap, auth, security, WS/SSE, route mounting
  src/routes/         extracted REST/SSE route modules
  src/core/           config, db, event bus, settings, employees
  src/http/           ok/fail response helpers and error middleware
  src/security/       path, filename, origin, and audit guards

Agent runtime
  src/agent/          spawn, resume, lifecycle, retry, watchdog
  src/agent/events/   provider event adapters and tool-label mapping
  src/cli/registry.ts 13 runtime registry entries and defaults
  src/prompt/         prompt assembly, skills, runtime context, memory injection

Workflow and memory
  src/orchestrator/   IPABCD/PABCD state machine, dispatch, worker progress
  src/goal/           persistent goal lifecycle and completion evidence gates
  src/goal-run/       bounded goal-run preview state
  src/task/           agent-native task checklist store
  src/memory/         local structured memory, heartbeat schedules, indexing

Manager dashboard
  src/manager/        multi-instance dashboard server, notes, board, reminders,
                      schedule, connector, git diff, memory federation
  public/manager/     React manager frontend

Browser and automation
  src/browser/        CDP primitives, runtime diagnostics, tab lifecycle
  src/browser/web-ai/ ChatGPT/Gemini/Grok web-AI session automation
  src/browser/adaptive-fetch/ URL reader and browser-escalation pipeline
```

Current core API shape, as of June 10, 2026:

- `server.ts`: 593 lines of glue/bootstrap.
- REST/SSE routes: 201 handlers including `/`; 200 API/media endpoints.
- Browser API: 43 handlers in `src/routes/browser.ts`, including Web-AI code-mode and code-extract routes.
- Public event type names: 47.
- Primary web event channel: `GET /api/events` SSE, with legacy WebSocket fallback only for pre-X-01 servers.
- Slash command registry: 40 commands across CLI, Web, Telegram, and Discord.
- Runtime registry: 13 top-level runtimes.

---

## Runtime Registry

`src/cli/registry.ts` is the single source for runtime keys, default models, and
model choices. Current top-level runtimes are:

| Runtime | Role |
| --- | --- |
| `pi` | Pi RPC runtime with isolated `PI_CODING_AGENT_DIR` profiles |
| `agy` | Antigravity print-mode runtime |
| `ai-e` | AI-E wrapper runtime |
| `claude` | Anthropic Claude CLI |
| `claude-e` | Claude E helper-backed runtime |
| `codex` | OpenAI Codex CLI |
| `codex-app` | Codex App stdio bridge |
| `cursor` | Cursor Agent CLI runtime |
| `gemini` | Gemini CLI runtime |
| `grok` | Grok CLI runtime |
| `kiro-code` | AWS Kiro CLI runtime |
| `opencode` | OpenCode runtime |
| `copilot` | GitHub Copilot ACP runtime |

Wrapper runtimes such as `ai-e`, `claude-e`, and `codex-app` delegate to their
underlying tools but remain first-class registry keys. `agy`, `cursor`, `grok`,
and `kiro-code` are not AI-E providers; they are top-level runtime surfaces.

---

## Request Flow

```text
User prompt
  -> interface adapter (Web, CLI/TUI, Telegram, Discord)
  -> src/orchestrator/gateway.ts
  -> slash command parser or normal agent submission
  -> src/agent/spawn.ts
  -> provider CLI process
  -> src/agent/events/* adapter
  -> src/core/bus.ts broadcast
  -> SSE event bus + trace/tool-log snapshots + internal listeners
```

Important boundaries:

- `src/core/bus.ts` publishes public events to `src/core/event-bus.ts` for SSE
  and still calls internal listeners for collectors/forwarders.
- `src/routes/events.ts` exposes `GET /api/events`, a data-only SSE stream.
  Topic and event name are JSON fields in each `data:` payload.
- `public/js/event-channel.ts` owns the browser EventSource singleton,
  exponential reconnect, `Last-Event-ID` replay, and fallback notification when
  a legacy server has no `/api/events`.
- `public/js/ws.ts` still owns legacy WebSocket compatibility and event-specific
  UI dispatch.

---

## Orchestration

CLI-JAW uses explicit orchestration for complex work:

```text
I (Interview) -> P (Plan) -> A (Audit) -> B (Build) -> C (Check) -> D (Done)
```

Key points:

- PABCD entry is explicit through `jaw orchestrate`, `/orchestrate`, or
  `/pabcd`.
- Resume is explicit `/continue`; natural-language “continue/계속/이어서” is a
  normal prompt.
- `/plan` is a compatibility guide for PABCD P, not a separate planning mode.
- `/review [focus]` resolves a validated project directory from configured
  `projectDirs` or recent conversation/git evidence; it does not fall back to
  JAW_HOME or bare `process.cwd()`.
- `/goal plan` and `/goalplan` store a raw `planHint` and require
  `/goal refine <specific objective>` or `cli-jaw goal refine ...` before
  checkpoints are accepted.
- `/goal run ...` is the bounded automation preview surface. Budget enforcement
  is tracking-oriented unless the corresponding gate has been implemented.
- Worker progress is query-first through `jaw worker status` and watchable via
  `jaw worker watch` or `jaw dispatch --watch`.

---

## API Surfaces

Use `structure/server_api.md` for the full table. Major route groups:

| Group | Examples |
| --- | --- |
| Core/system | `/api/health`, `/api/session`, `/api/runtime`, `/api/auth/token` |
| Messages/sessions | `/api/messages`, `/api/messages/count`, `/api/chat-sessions` |
| Events | `/api/events` SSE |
| Commands | `/api/command`, `/api/commands`, `/api/message` |
| Orchestration | `/api/orchestrate/*` including dispatch, batch dispatch, state, worker progress |
| Goals/tasks | `/api/goal`, `/api/goal-run`, `/api/task` |
| Runtime settings | `/api/settings`, `/api/cli-registry`, `/api/cli-status`, `/api/quota` |
| Memory | `/api/jaw-memory/*`, `/api/memory/*`, dashboard memory federation |
| Browser | `/api/browser/*`, `/api/browser/web-ai/*` |
| Messaging | `/api/channel/send`, `/api/telegram/send`, `/api/discord/send` |
| Manager | `/api/dashboard/board/*`, `/api/dashboard/schedule/*`, manager-only routes |
| Jaw CEO | `/api/jaw-ceo/*` |
| Traces/security | `/api/traces/*`, `/api/security-audit/*` |

`/api/channel/send` is the canonical outbound channel send endpoint. Telegram
and Discord direct endpoints remain compatibility/direct paths.

---

## Manager Dashboard

`jaw dashboard serve` runs a separate manager server on port `24576` by default.
Electron implicit spawn uses a separate `24577-24590` lane.

The manager owns:

- multi-instance discovery and cached `InstanceRegistry` scans,
- live instance previews and preview-origin proxying,
- board, schedule, reminders, and connector surfaces,
- notes, WYSIWYG editing, graph/search, snippets, history, and assets,
- git diff repo candidates, summary, and file diff APIs,
- read-only dashboard memory federation and optional embedding search,
- Electron panel bridges for terminal, browser, diff, folder, docs, and Jaw CEO.

Manager routes are documented separately in `structure/server_api.md` because
they are not all mounted on the core `server.ts` app.

---

## Electron Desktop

The Electron app now ships as a self-contained desktop runtime instead of
depending solely on a globally installed `jaw` binary. Packaged desktop builds
include a Node.js sidecar:

- `scripts/bundle-sidecar.sh` downloads Node.js 24.17 for the target platform.
- The sidecar copies `dist/`, `public/`, `package.json`, and production
  dependencies into `electron/sidecar/server`.
- Frontend-only dependencies are pruned before packaging.
- `better-sqlite3` is rebuilt against the bundled Node runtime.
- A generated `bin/jaw` or `bin/jaw.cmd` shim launches `dist/bin/cli-jaw.js`.
- `electron/electron-builder.yml` ships the sidecar as `extraResources/server`.
- `electron/src/main/lib/jaw-spawn.ts` prefers the bundled sidecar `jaw` before
  falling back to `JAW_BIN` or a global `jaw`.

Current release targets:

- macOS arm64: DMG + ZIP
- Windows x64: NSIS installer + ZIP
- Linux x64: AppImage

`.github/workflows/desktop-release.yml` builds these artifacts on GitHub Release
publish and through manual `workflow_dispatch`.

---

## Build And Verification

Common local commands:

```bash
npm run build
npm run build:frontend
npm test
npm run gate:all
bash structure/check-doc-drift.sh
bash structure/verify-counts.sh
```

Frontend TypeScript under `public/js/**/*.ts` requires `npm run build:frontend`.
Backend TypeScript under `src/**/*.ts` requires `npm run build` or
`npm run typecheck`.

Desktop packaging:

```bash
npm install
npm --prefix electron install
npm run electron:dev
npm run electron:dist:mac
```

`npm run electron:dist:mac` now runs frontend build, sidecar bundling, Electron
build, and macOS packaging.

---

## Documentation Sync

When command, API, orchestration, runtime, manager, or desktop behavior changes,
update these together:

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `structure/AGENTS.md`
- `structure/INDEX.md`
- `structure/server_api.md`
- `structure/commands.md`
- `structure/str_func.md`
- `docs/ARCHITECTURE.md`
- `electron/README.md` when desktop behavior changes

Run `bash structure/check-doc-drift.sh` before calling the docs current.
