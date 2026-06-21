> 📚 [INDEX](INDEX.md) · [Sync Checklist](AGENTS.md) · [Commands](commands.md) · [Server API](server_api.md) · [Stream Events](stream-events.md) · [str_func](str_func.md)

# structure/ — Sync Guide

- Keep this folder aligned with the live `cli-jaw` tree. The current hub covers 19 Markdown docs plus 5 support files.
- Update `INDEX.md` whenever a doc is added, removed, renamed, or re-scoped. Keep the doc map, tier list, and quick links in sync.
- Update `str_func.md` and `verify-counts.sh` together when source counts, `server.ts`, `src/routes/*`, `src/cli/handlers*.ts`, `src/cli/api-auth.ts`, `src/manager/*` (multi-instance dashboard), `bin/commands/*`, `bin/star-prompt.ts`, `tests/`, `public/`, or generated-dist exclusions change. The verifier now checks every file-tree `(NNNL)` entry in `str_func.md`, not only curated hotspots.
- `stream-events.md` is the SSE/WS/event-trace companion for `frontend.md`, `server_api.md`, and the ProcessBlock pipeline. Keep `GET /api/events`, replay behavior, fallback WS, and `agent:claude-e:*` naming current.
- `normalize-status.ts` and `status-scope.json` feed the fin-status audit flow. If their contract changes, update `audit-fin-status.sh` and any related docs in this folder.
- When a command, API, UI, memory, or orchestration surface changes, sync the relevant doc(s) in this directory in the same change.
- Route refactors belong in `INDEX.md`, `server_api.md`, `infra.md`, and `str_func.md`. CLI handler splits and auth helper changes belong in `commands.md`, `memory_architecture.md`, `telegram.md`, and `str_func.md`.

## Current sync hotspots (2026-06)

When refreshing docs from recent non-strict commits, check these first:

- `src/orchestrator/parser.ts` / `pipeline.ts`: `/continue` is slash-only; do not document natural-language continue as resume.
- `src/cli/commands.ts` / `src/cli/handlers/session-handlers.ts` / `src/core/chat-sessions.ts`: slash registry currently includes 40 commands. Keep quoted-argument `tokenizeArgs()`, Levenshtein unknown-command recovery, `/goalplan`, `/gd`, `/review`, `/task`, and `/fork` reflected in `commands.md`.
- `src/prompt/templates/a1-system.md` / `src/prompt/templates/skills.md` / `skills_ref/search/SKILL.md` / `skills_ref/browser/SKILL.md`: Korean/source-sensitive search defaults to native cli-jaw search with focused query rewrite + original-page verification; `agbrowse research plan` is optional planning help only. Private runtime skills such as `k-writing` (Korean promotional/content writing; retired label: `k-thread-gen`) and `lecture-stt` are active-skill deployments, not `skills_ref` public entries. Route Korean promotional/content writing through active `k-writing`, not free-form prose or the retired label.
- `src/agent/lifecycle-handler.ts` / `src/trace/redact.ts`: retry docs should mention exponential backoff attempt metadata and trace redaction should include AWS, Anthropic, JWT, and expanded secret key patterns.
- `src/cli/commands.ts` / `src/cli/handlers-workflows.ts` / `src/command-contract/catalog.ts` / `src/workflows/*`: workflow helper commands are `/plan`, `/interview`, `/deliberate`, `/planaudit`, and `/goal`; `/plan` is a PABCD P compatibility guide, not a second planning mode; bounded automation belongs under `/goal run ...`, not a top-level `/autopilot`; keep `/planaudit` remote-safe and do not document `/plan-audit` as registered unless an interface-aware alias layer exists.
- `src/agent/args.ts` + `src/agent/spawn.ts`: Gemini full-access must keep auto-approval and pass OS home roots through `--include-directories` so cwd-external folders do not fail with `Path not in workspace`; WSL should include both Linux home and the Windows user home when discoverable.
- `src/shared/tool-log-sanitize.ts`: bounded tool-log storage/delivery protects Web UI and Manager ProcessBlock hydration.
- `src/messaging/send.ts` + `src/routes/messaging.ts`: `/api/channel/send` is canonical outbound channel delivery.
- `src/core/event-bus.ts` + `src/routes/events.ts` + `public/js/event-channel.ts`: Web event delivery is SSE-first through `GET /api/events` with WebSocket fallback for legacy servers.
- `src/browser/runtime-*`, `src/browser/tab-lifecycle.ts`, `src/browser/web-ai/session*.ts`: browser docs should mention runtime diagnostics, orphan cleanup, tab lifecycle, and web-ai session reattach.
- `src/browser/adaptive-fetch/*`, `src/routes/browser.ts`, `bin/commands/browser.ts`: browser docs should keep `browser fetch <url>` scoped as an adaptive URL/search-result reader, not generic search, with browser escalation and third-party reader opt-in boundaries explicit.
- `src/routes/traces.ts` / `src/trace/*`: server docs should include public trace read routes and related WebSocket/event surfaces such as `alert_escalation`.
- `src/manager/notes/search.ts` / `src/manager/notes/routes.ts` / `public/manager/src/notes/NotesSearchSidebar.tsx`: Manager notes docs should include ripgrep-backed search, `/api/dashboard/notes/search`, typed errors, abortable sidebar search, and search CSS.
- `src/manager/reminders/*` / `public/manager/src/dashboard-reminders/*`: Manager docs should include dashboard reminders API, notification scheduler, matrix buckets, top-priority strip, detail popover, and drag/drop bucket moves.
- `src/orchestrator/pipeline.ts` / `src/orchestrator/state-machine.ts` / `skills_ref/dev*/SKILL.md`: PABCD docs should keep the `Project root: <absolute path>` dispatch contract and strict TypeScript + existing SOT/devlog discovery guidance aligned.
- `src/orchestrator/worker-registry.ts` / `src/routes/orchestrate.ts` / `bin/commands/worker.ts`: worker progress query/watch is memory-only for current plus previous completed run, safe-summary only, and must not expose employee thinking detail.
- `src/agent/args.ts` + `src/agent/spawn.ts` + `src/agent/spawn-env.ts` + `src/cli/registry.ts` + `src/cli/readiness.ts`: AGY is a top-level `agy` runtime, not an `ai-e` provider. It uses `agy -p` print mode with AGY's current native selected model, exact resume via `--conversation <sessionId>`, plain-text stdout, `NO_COLOR=1`, run-time auth checking, and no per-run `--model`/`--effort` flags.
- `src/agent/cursor-runtime.ts` + `src/agent/events/cursor.ts` + `src/agent/args.ts` + `src/cli/registry.ts` + `src/cli/readiness.ts`: Cursor is a top-level `cursor` runtime, not an `ai-e` provider. It uses `cursor-agent -p --trust --output-format stream-json`, exact resume via `--resume <chatId>`, model ids resolved from model+effort before spawn, auth via `CURSOR_API_KEY` or `cursor-agent status`, and status-only quota metadata until Cursor CLI exposes quota windows.
- Keep root `AGENTS.md`, `CLAUDE.md`, `README.md`, and public `docs/dev/` pages aligned with this folder when the architecture map changes.
