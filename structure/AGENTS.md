> 📚 [INDEX](INDEX.md) · [Sync Checklist](AGENTS.md) · [Commands](commands.md) · [Server API](server_api.md) · [Stream Events](stream-events.md) · [str_func](str_func.md)

# devlog/structure — Sync Guide

- Keep this folder aligned with the live `cli-jaw` tree. The current hub covers 17 Markdown docs plus 5 support files.
- Update `INDEX.md` whenever a doc is added, removed, renamed, or re-scoped. Keep the doc map, tier list, and quick links in sync.
- Update `str_func.md` and `verify-counts.sh` together when source counts, `server.ts`, `src/routes/*`, `src/cli/handlers*.ts`, `src/cli/api-auth.ts`, `src/manager/*` (multi-instance dashboard), `bin/commands/*`, `bin/star-prompt.ts`, `tests/`, `public/`, or `public/dist/` totals change.
- `stream-events.md` is the event-trace companion for `frontend.md`, `server_api.md`, and the ProcessBlock pipeline. Keep those references current.
- `normalize-status.ts` and `status-scope.json` feed the fin-status audit flow. If their contract changes, update `audit-fin-status.sh` and any related docs in this folder.
- When a command, API, UI, memory, or orchestration surface changes, sync the relevant doc(s) in this directory in the same change.
- Route refactors belong in `INDEX.md`, `server_api.md`, `infra.md`, and `str_func.md`. CLI handler splits and auth helper changes belong in `commands.md`, `memory_architecture.md`, `telegram.md`, and `str_func.md`.
