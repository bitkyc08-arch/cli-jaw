# CLI-JAW Claude Guide

This repository is a Node.js ESM orchestration runtime for boss/employee dispatch, Web UI, browser/CDP automation, Telegram/Discord/Slack channels, memory, heartbeat, and PABCD orchestration.

## Documentation Map

- Start at `structure/INDEX.md` for the current architecture map.
- Keep `README.md`, `AGENTS.md`, this file, and `structure/AGENTS.md` aligned when command/API/orchestration behavior changes.
- Do not use the old `devlog/structure/` path for architecture docs; the active folder is `structure/`.

## Build & Deploy Contract

- The running server executes compiled `dist/` (`jaw serve` → `dist/server.js`), never the TS sources. After changing `server.ts`/`src/**`/`bin/**`, run `npm run build` before telling anyone to restart; frontend changes additionally need `npm run build:frontend`. Full rules: `AGENTS.md` § Build & Deploy Contract.

## Current Runtime Notes

- New installations prefer Codex App when capability and auth are ready; existing saved runtimes change only through the one-time accept/keep Settings action. CLI status is served from a nullable stale-while-revalidate cache whose probes run in a bounded child. OpenCodex diagnostics compare the read-only Codex root URL with the live runtime fingerprint and never modify Codex config.
- PABCD entry is explicit: `jaw orchestrate`, `/orchestrate`, or `/pabcd`. Resume is explicit `/continue`; natural-language “continue/계속/이어서” remains a normal prompt.
- Workflow helper slash commands are `/plan`, `/interview`, `/deliberate`, `/planaudit`, `/review`, `/search`, `/goal`, `/goalplan`, `/team`, `/task`, `/fork`, and `/gd`. Dynamic `/skill:<id>` injects an active skill on CLI/Web. `/plan` is a compatibility guide for users expecting a plan command; it maps to PABCD P and does not create another planning mode. `/planaudit` is the canonical remote-safe spelling; `/plan-audit` is not registered. `/search <query>` forces the active search skill policy, rewrites focused queries, discovers candidate URLs, and uses browser commands only for evidence verification after candidates exist. Bounded automation is a `/goal run ...` subcommand family, not a separate top-level `/autopilot` command; current `/goal run` controls are tracking-oriented runtime gates.
- `/goal plan [hint]`, `/goalplan [hint]`, and `cli-jaw goal plan [hint]` create a pending plan-mode goal. The raw hint is stored separately as `planHint`, not as the durable objective. Agents must refine with `/goal refine <specific objective>`, `cli-jaw goal refine "<specific objective>"`, or `/api/goal` `refine-objective` before checkpoints are accepted.
- Agent pause is a two-tap audited gate. After the first `--agent --audit` attempt, the goal remains persisted as `active` but status/API surfaces expose derived `pauseGate: { armed: true, reason: "pause_gate_pending" }`; one audit/finalizer goal-continuation may run, and if that turn exits with the gate still armed it emits `goal_pause_gate_pending` without scheduling another kick. A second audited pause pauses the goal; a productive checkpoint clears the gate.
- PABCD forward transitions require `jaw orchestrate <phase> --attest '{"from","to","did",...}'` (C→D also `checkOutput`/`exitCode`). Goal mode self-advances but still uses attestation as proof-of-work. See `structure/prompt_flow.md`.
- Optimization/score-maximization goals follow the optimization-loop discipline (LOOP-PHASE-DEATH/CONTINUITY/CANDIDATE-ANCHOR/INSTANCE-CHECK + GATE-ORACLE-VALIDITY):
  classify candidate changes, ban a class after 3 consecutive discards, force evaluator-gate work on repeated D-phase deaths.
  Canonical: dev-pabcd §10, dev-testing §9.5; injected via orchestration template and goal continuation.
- Pre-prompt context hooks: optional `~/.cli-jaw/context-hooks.json`, scopes `main`/`heartbeat`, `cli-jaw hooks inspect`. See `docs/dev/pre-prompt-context-hooks.md`.
- **Telegram Hub** (P0–P4): forum-topic routing via Dashboard `/api/dashboard/telegram-hub`; hub commands `/setthread` `/threads` `/hubhelp`; per-topic `model`/`systemPrompt` overrides (P4). One bot token → one long-poller. See `structure/telegram.md`.
- Bounded local search (prompt-injected): Grep/Glob from one known file or narrow directory only; external/Korean search via `/search` / active search skill. See `structure/prompt_flow.md`.
- `npm test` runs `tests/run.mts` (programmatic driver, `isolation:'process'`). See `structure/infra.md`.
- Standalone lifecycle is home-scoped: `jaw --home <path> service stop|restart [--port N]` verifies `<JAW_HOME>/jaw.pid.json` before signalling; registered launchd/systemd instances delegate to their native manager. Never recommend killing every Node process. See `structure/commands.md`.
- `/review` is a project-dir review workflow: it uses configured `projectDirs` or a validated recent-context git repo, never JAW_HOME/`process.cwd()` fallback, treats `/review [focus]` user text as the highest-priority scope signal, resolves the review scope from the current conversation focus plus recent goal/chat context and commit history/diffs/worktree/untracked files, saves a Markdown report with scope evidence, and scopes `--fix` to Critical/High findings as new working-tree patches on top of current `HEAD` without rewriting commits. Git ranges are evidence for the conversation-selected work item, not permission to include unrelated recent commits.
- Korean promotional/content writing (홍보 쓰레드, 인스타 카드뉴스, 링크드인, 웹/블로그 게시물, 윤문) is owned by the active private runtime `k-writing` skill, not free-form prose or the retired `k-thread-gen` label. Route by channel first, then run the mandatory workflow: pre-search, content-type detection, 3-candidate hook scoring, tone/module formatting, and anti-AI-tell plus 인간다움 checks before output.
- Pi (`pi`) is a top-level runtime above AI-E, not a hosted-provider SDK inside cli-jaw. It runs per turn through `pi --mode rpc` with cli-jaw-owned `settings.pi` profiles, isolated `PI_CODING_AGENT_DIR` config generation, Settings profile registration, and npm-exec fallback for machines without a global `pi` binary.
- AGY (`agy`) is a top-level runtime, not an `ai-e` provider. It runs in print mode through `agy -p`; optional flags such as `--model` are capability-probed before emission (AGY 1.0.12 supports `--model`; probe failure falls back to legacy emit-all compatibility), captures print-mode session ids from a per-run `--log-file`, resumes exact saved sessions with `--conversation <id>`, exposes no per-run `--effort` flag, checks auth at run time, and uses plain-text stdout rather than NDJSON parsing. Native AGY context-file ingestion is separate from cli-jaw's wrapper-injected operational context, exact resume policy, transcript anchoring, quota UI, and post-compaction invariants.
- Grok (`grok`) quota uses the current `~/.grok/auth.json` OIDC `key` against Grok Build billing gRPC-web for the SuperGrok weekly usage pool, then falls back to legacy `cli-chat-proxy.grok.com/v1/billing` monthly credits when the weekly endpoint is unavailable.
- Cursor (`cursor`) is a top-level experimental runtime, not an `ai-e` provider. It runs through `cursor-agent -p --trust --output-format stream-json`, resumes with `--resume <chatId>`, uses `--model <resolvedModelId>`, and encodes effort in the model id rather than passing a separate `--effort`/`--thinking` flag. Cursor quota is auth/status-only until the CLI exposes quota windows.
- Kiro (`kiro-code`) is a top-level runtime, not an `ai-e` provider. It runs through `kiro-cli chat --no-interactive`, resumes with `--resume-id <sessionId>`, passes `--model` and optional `--trust-all-tools`, parses plain-text stdout (ANSI stripped), emits `agent_tool` steps from Kiro tool progress lines, shows AGY-style working indicators while busy, and captures session ids from the kiro-cli v2 session store (`conversations_v2` in the kiro-cli data sqlite, keyed by the canonical cwd) — the legacy `~/.kiro/sessions/cli/*.json` files are not used by `chat --no-interactive`. Fresh Kiro turns include cli-jaw operational context + bounded history; resumed Kiro turns send only the current prompt because the native session already owns prior context. Live models come from `kiro-cli chat --list-models --format json`; quota uses reverse-engineered `AmazonCodeWhispererService.GetUsageLimits` with the Kiro CLI auth store token.
- Claude E is the registry key `claude-e`; runtime telemetry uses `agent:claude-e:*`. Some persisted helper/session internals still use the historical `claude-i` bucket for compatibility.
- Gemini full-access runs use `--skip-trust --approval-mode yolo` on both fresh and resume sessions.
- `/api/channel/send` is the canonical outbound Telegram/Discord/Slack delivery endpoint.
- Slack connection environment variables own their matching fields at runtime: `GET /api/settings` reports `slackEnvironmentVariables` while redacting values, Settings and CLI setup conservatively refuse connection editing while any are present, generic `PUT`s reject only env-owned paths, and persistence strips only those fields so environment values never enter `settings.json` or erase unrelated file-backed credentials. Full `POST /api/settings/slack/reset` still returns `409` while any connection env variable exists.
- Heartbeat schedules support `{ kind: "every", minutes }` and `{ kind: "cron", cron, timeZone? }`.
- Tool logs are capped by `src/shared/tool-log-sanitize.ts` before SSE/WebSocket, `agent_done`, and orchestration snapshot delivery. Web UI delivery is SSE-first through `GET /api/events`, with WebSocket as the legacy fallback dispatcher.
- Employee worker progress is query-first via `jaw worker status [agent]`, watchable via `jaw worker watch [agent]` or `jaw dispatch --watch`, memory-only for current plus previous completed run, and safe-summary only with thinking detail hidden.
- `jaw employee list [--json]` lists DB and static employees, including Control. `jaw dispatch` reads response bodies defensively and reports stale/missing server routes when an old manager returns HTML instead of JSON.
- `npm run build` is a pure backend build/link operation and must not signal, kill, or restart live manager processes.
- Web/CLI `jaw dashboard serve` defaults to manager port `24576`; Electron implicit spawn owns the separate `24577-24590` manager lane and does not reuse `24576`.
- The Electron Manager right sidebar uses an open-tab model (2026-07-04): module tab kinds `files | diff | browser | design`, multi-instance except the Diff singleton, launcher row + equal-width tab strip + `+` menu, per-tab resource state persisted in tab metadata (`RightSidebarOpenTab.files/browser/design`), only the ACTIVE tab body mounts (hidden Electron webviews composite over the window), CEO hidden. Plans: `devlog/_plan/260705_electron_file_folder_unified_tabs/`.
- Design workspace v1: `jaw design <list|create|show|path|rescan|edit|export|files|snapshots|catalog>` is FILE-FIRST over `src/manager/design/store.ts` (`~/.cli-jaw-dashboard/design/projects/<project-key>/pages/<page-id>/`, `page.json` source of truth, revision 409s, keep-last-20 snapshots). Manager routes live at `/api/dashboard/design` (mutators require the Electron desktop header; preview is CSP-locked, `script-src 'none'`). The Design module tab's Run button enqueues a pageDir-scoped generation prompt into the currently selected instance.
- Embedded Browser agent surface (030, v1–v5): agent-visible Manager Browser pages are relayed into the SELECTED instance's runtime-context by default. Agent endpoints via a renderer-relayed command queue: `POST …/<targetId>/screenshot` (PNG temp-file path), `POST …/<targetId>/snapshot` (bounded accessibility tree), and `POST …/<targetId>/act` (click/type/scroll/key). `act` is available for agent-visible targets by default (`actionsEnabled` remains a compatibility flag) and still validates payload bounds + re-checks the current URL policy in main. Element inspect/actions use Electron CDP attachment with ONLY DOM/Overlay/Input/Accessibility domains (native element-box highlight via `Overlay.setInspectMode`); the Runtime domain / page-side script evaluation is never enabled. Page titles/urls are sanitized + JSON-delimited before entering agent context.
- `jaw browser fetch <url>` is the adaptive URL-reader mirror from agbrowse: use it for a known URL/search-result URL, not as generic search. For raw search intent, use `/search <query>` so the search skill can choose search, browser verification, and model-gated parallel research policy.
- Platform classification has one source of truth: `src/core/platform-kind.ts` (`windows-native | wsl | linux | darwin | other`). `process.platform` decides first, so a `win32` process can never be classified as WSL, and the WSL branch is reachable only from `linux`. **`WSLENV` is never a WSL signal** — Microsoft shares it with the Windows host, so testing it made `doctor` and `postinstall` misfire on native Windows. `browser-open.ts`, `browser-open-default.ts`, `browser/connection.ts`, and `bin/commands/doctor.ts` delegate to it; `bin/postinstall.ts` answers the separate launch-origin question with `isWindowsNodeLaunchedFromWsl` + `resolveInvocationCwd` (npm lifecycle scripts run from the package root, so `INIT_CWD` is the user's directory). `jaw doctor --json` exposes the result as `platform`. Do not add another hand-rolled WSL check.

## Build

Backend and frontend are separate builds. **Both must run after source changes.**

```bash
npm run build            # backend only (tsc → dist/)
npm run build:frontend   # frontend only (vite → public/dist/)
```

- `public/js/**/*.ts` changes require `npm run build:frontend` — the browser loads Vite-bundled output from `public/dist/`, not raw TS.
- Backend `src/**/*.ts` changes require `npm run build`.
- After editing frontend code, ALWAYS run `npm run build:frontend` before reporting the change is applied.

## Local Gates

Prefer the existing gates only:

```bash
npm run gate:all
npm test
bash structure/audit-fin-status.sh
```

Doc-only changes should not modify `.mjs`, `.js`, or `.ts` source files unless explicitly requested.
