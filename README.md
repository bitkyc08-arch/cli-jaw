<div align="center">

# CLI-JAW

### All your AI subscriptions. One assistant.

[![npm](https://img.shields.io/npm/v/cli-jaw)](https://npmjs.com/package/cli-jaw)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](#-docker)

**English** / [한국어](README.ko.md) / [中文](README.zh-CN.md)

<video src="https://github.com/user-attachments/assets/a7cf17c9-bfb3-44f0-b7fd-d001a39643fd" autoplay loop muted playsinline width="100%"></video>

</div>

<table>
<tr><td><b>Your existing subscriptions, unified</b></td><td>Claude Max, ChatGPT Pro, Copilot, Gemini Advanced — route through OAuth. Add any model via OpenCode. No per-token billing.</td></tr>
<tr><td><b>Lives where you do</b></td><td>Web PWA with virtual scroll and WS streaming, Mac WebView app, terminal TUI, Telegram with voice, Discord — five surfaces, one conversation.</td></tr>
<tr><td><b>3-layer memory</b></td><td>History Block (recent sessions) + Memory Flush (episodes, daily logs) + Soul and Task Snapshot (identity, semantic recall). SQLite FTS5 full-text search.</td></tr>
<tr><td><b>Multi-agent orchestration</b></td><td>PABCD — a DB-persisted 5-phase FSM. Employee system with worker registry. Parallel subtasks with file-overlap detection. You approve every phase.</td></tr>
<tr><td><b>Browser and desktop automation</b></td><td>Chrome CDP, vision-click, DOM reference for ChatGPT/Grok/Gemini, Computer Use integration via Codex App, diagram skill for SVG and interactive visualizations.</td></tr>
<tr><td><b>MCP install once, 5 engines</b></td><td><code>jaw mcp install</code> syncs to Claude, Codex, Gemini, OpenCode, and Copilot simultaneously. One config file.</td></tr>
<tr><td><b>Speaks your language</b></td><td>English, Korean, Chinese README. i18n web UI. HWP/HWPX Korean office document support via OfficeCLI.</td></tr>
</table>

---

## Quick links

- [Install](#-install--run) · [Authenticate](#-authenticate) · [Surfaces](#-where-it-lives)
- [Engine routing](#-engine-routing) · [Memory](#-memory) · [PABCD](#-orchestration--pabcd) · [Skills](#-skills)
- [Browser automation](#-browser--desktop-automation) · [MCP](#-mcp) · [Messaging](#-messaging)
- [CLI commands](#%EF%B8%8F-cli-commands) · [Docker](#-docker) · [Docs](#-documentation) · [How it compares](#-how-it-compares)

<details>
<summary>Are you on Windows? — WSL one-click setup</summary>

**Step 1: Install WSL** (PowerShell as Admin)

```powershell
wsl --install
```

Restart, then open **Ubuntu** from the Start Menu.

**Step 2: Install CLI-JAW**

```bash
curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install-wsl.sh | bash
```

**Step 3: Reload shell and start**

```bash
source ~/.bashrc
copilot login    # or: claude auth / codex login / gemini
jaw serve        # → http://localhost:3457
```

<details>
<summary>Troubleshooting WSL</summary>

| Problem | Fix |
|---|---|
| `unzip: command not found` | Rerun the installer |
| `jaw: command not found` | `source ~/.bashrc` |
| Permission errors | `sudo chown -R $USER $(npm config get prefix)` |

</details>
</details>

<details>
<summary>New to the terminal? — One-click install (macOS)</summary>

1. Open **Terminal** (`Cmd + Space` → type `Terminal`)
2. Paste and hit Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install.sh | bash
```

3. Authenticate and launch:

```bash
copilot login
jaw serve        # → http://localhost:3457
```

</details>

---

## 🚀 Install & run

```bash
npm install -g cli-jaw
jaw serve
```

Open **http://localhost:3457**. Requires Node.js 22+ and at least one AI CLI authenticated below.

> `jaw service install` — auto-start on boot (systemd, launchd, or Docker, auto-detected).

---

## 🔑 Authenticate

You only need one. Pick whichever subscription you already have:

```bash
# Free
copilot login        # GitHub Copilot
opencode             # OpenCode — free models available

# Paid (monthly subscription)
claude auth          # Anthropic Claude Max
codex login          # OpenAI ChatGPT Pro
gemini               # Google Gemini Advanced
```

Check status: `jaw doctor`

<details>
<summary>Example jaw doctor output</summary>

```
🦈 CLI-JAW Doctor — 12 checks

 ✅ Node.js        v22.15.0
 ✅ Claude CLI      installed
 ✅ Codex CLI       installed
 ⚠️ Gemini CLI      not found (optional)
 ✅ OpenCode CLI    installed
 ✅ Copilot CLI     installed
 ✅ Database        jaw.db OK
 ✅ Skills          22 active, 94 reference
 ✅ MCP             3 servers configured
 ✅ Memory          MEMORY.md exists
 ✅ Server          port 3457 available
```

</details>

---

## 🖥️ Where it lives

CLI-JAW works from five surfaces. Same assistant, same memory, same skills across all of them.

| Surface | What you get |
|---|---|
| **Web PWA** | Full UI with markdown/KaTeX/Mermaid rendering, virtual scroll, WS streaming, drag-and-drop file upload, voice recording, PABCD roadmap bar, i18n (English, Korean), dark/light theme, offline message cache via IndexedDB |
| **Mac WebView app** | `jaw serve` wrapped in a native macOS app shell. Access from Dock without opening a browser |
| **Terminal TUI** | Multiline editing, slash-command autocomplete, overlay selectors, session persistence, resume classification |
| **Telegram** | Voice messages (multi-provider STT), photos, files. Scheduled task results delivered automatically. Slash commands for model/CLI switching |
| **Discord** | Text and file messaging, command sync, channel/thread routing, forwarder for agent results |

---

## 🔀 Engine routing

Five CLI backends, routed through OAuth subscriptions you already pay for. No per-token API billing.

| CLI | Default model | Auth | Cost model |
|---|---|---|---|
| **Claude** | `claude-sonnet-4-6` | `claude auth` | Claude Max subscription |
| **Codex** | `gpt-5.3-codex` | `codex login` | ChatGPT Pro subscription |
| **Gemini** | `gemini-2.5-pro` | `gemini` | Gemini Advanced subscription |
| **OpenCode** | `claude-opus-4-6-thinking` | `opencode` | Free models available |
| **Copilot** | `gpt-4.1` | `copilot login` | Free tier available |

**Fallback chain**: if one engine is rate-limited or down, the next picks up automatically. Configure with `/fallback [cli1 cli2...]`.

**OpenCode wildcard**: connect any model endpoint — OpenRouter, local LLMs, or any OpenAI-compatible API.

> Switch engines: `/cli codex`. Switch models: `/model gpt-5.4`. All from Web, Terminal, Telegram, or Discord.

---

## 🧠 Memory

Three layers, each serving a different recall horizon.

| Layer | What it stores | How it works |
|---|---|---|
| **History Block** | Recent session context | `buildHistoryBlock()` — last 10 sessions, max 8000 chars, scoped to working directory. Injected at prompt start |
| **Memory Flush** | Structured knowledge extracted from conversations | Triggered after threshold (default 10 turns). Extractor prompt summarizes into episodes, daily logs (`YYYY-MM-DD.md`), live notes. Stored as markdown files |
| **Soul + Task Snapshot** | Identity and semantic recall | `soul.md` defines core values, tone, boundaries. Task Snapshot searches FTS5 index for up to 4 semantically relevant hits (700 chars each) per prompt |

All three layers feed into the system prompt automatically. Memory is searchable: `jaw memory search <query>` or `/memory <query>` from any interface.

Advanced memory includes profile summary, bootstrap/migration, and reindex flows accessible from the Web UI settings.

---

## 🎭 Orchestration — PABCD

For complex tasks, CLI-JAW uses a 5-phase state machine. You approve every transition.

```
P (Plan) → A (Audit) → B (Build) → C (Check) → D (Done) → IDLE
   ⛔         ⛔          ⛔         auto        auto
```

| Phase | What happens |
|---|---|
| **P** | Boss AI writes a diff-level plan. Stops for your review |
| **A** | Read-only worker verifies the plan is feasible |
| **B** | Boss implements. Read-only worker verifies the result |
| **C** | Type-check, docs update, consistency check |
| **D** | Summary of all changes. Returns to idle |

State is DB-persisted and survives server restarts. Workers cannot modify files. Activate with `jaw orchestrate` or `/pabcd`.

---

## 📦 Skills

100+ skills, organized by what they do.

| Category | Skills | What they cover |
|---|---|---|
| **Office** | `pdf`, `docx`, `xlsx`, `pptx`, `hwp` | Read, create, edit documents. Korean HWP/HWPX via OfficeCLI |
| **Automation** | `browser`, `vision-click`, `screen-capture`, `desktop-control` | Chrome CDP, AI-powered coordinate click, macOS screenshot/camera, Computer Use |
| **Media** | `video`, `imagegen`, `lecture-stt`, `tts` | Remotion video rendering, OpenAI image generation, lecture transcription, text-to-speech |
| **Integration** | `github`, `notion`, `telegram-send`, `memory` | Issues/PRs/CI, Notion pages, Telegram media delivery, persistent memory |
| **Visualization** | `diagram` | SVG diagrams, charts, interactive visualizations rendered in chat |
| **Dev guides** | `dev`, `dev-frontend`, `dev-backend`, `dev-data`, `dev-testing`, `dev-pabcd`, `dev-code-reviewer` | Engineering guidelines injected into sub-agent prompts |

22 active skills (always injected). 94+ reference skills (loaded on demand).

```bash
jaw skill install <name>    # activate a reference skill
```

---

## 🌐 Browser & desktop automation

| Capability | How it works |
|---|---|
| **Chrome CDP** | Navigate, click, type, screenshot, evaluate JS, scroll, focus, press keys — 10 actions via DevTools Protocol |
| **Vision-click** | Screenshot the screen, AI extracts target coordinates, clicks. One command: `jaw browser vision-click "Login button"` |
| **DOM reference** | Documented selector maps for ChatGPT, Grok, and Gemini web UIs — model selection, stop buttons, tool drawers |
| **Computer Use** | Desktop app automation via Codex App Computer Use MCP. Routes DOM targets to CDP, desktop apps to Computer Use |
| **Diagram skill** | Generate SVG diagrams and interactive HTML visualizations, rendered in sandboxed iframes with copy/save controls |

---

## 🔌 MCP

[Model Context Protocol](https://modelcontextprotocol.io) lets AI agents use external tools. CLI-JAW manages MCP config for all five engines from one file.

```bash
jaw mcp install @anthropic/context7
# → syncs to Claude, Codex, Gemini, OpenCode, Copilot config files
```

No more editing five different JSON files. Install once, all engines get it.

```bash
jaw mcp sync       # re-sync after manual edits
```

---

## 💬 Messaging

### Telegram

```
📱 Telegram ←→ 🦈 CLI-JAW ←→ 🤖 AI Engines
```

<details>
<summary>Setup (3 steps)</summary>

1. Create a bot — message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. Configure — `jaw init --telegram-token YOUR_TOKEN` or use the Web UI settings
3. Send any message to your bot. Chat ID is auto-saved on first message

</details>

What works from Telegram: text chat, voice messages (auto-transcribed via multi-provider STT), file/photo upload, slash commands (`/cli`, `/model`, `/status`), scheduled task result delivery.

### Discord

Same capabilities as Telegram — text, files, commands. Channel and thread routing with forwarder for agent result broadcast. Setup via Web UI settings.

### Voice & STT

Voice input works on Web (mic button), Telegram (voice messages), and Discord. Providers: OpenAI-compatible, Google Vertex AI, or any custom endpoint. Configured in the Web UI settings.

---

## ⏰ Scheduling & heartbeat

| Feature | What it does |
|---|---|
| **Heartbeat jobs** | Cron-scheduled tasks that run unattended. Results delivered to Telegram/Discord |
| **Service auto-start** | `jaw service install` — auto-detects systemd (Linux), launchd (macOS), or Docker |
| **Memory auto-reflect** | Optional post-flush reflection for structured knowledge extraction |

---

## ⌨️ CLI commands

```bash
jaw serve                         # start server → http://localhost:3457
jaw chat                          # terminal TUI
jaw doctor                        # 12-point diagnostics
jaw service install               # auto-start on boot
jaw skill install <name>          # activate a skill
jaw mcp install <package>         # install MCP → syncs to 5 engines
jaw memory search <query>         # search memory
jaw browser start                 # launch Chrome (CDP)
jaw browser vision-click "Login"  # AI-powered click
jaw clone ~/project               # clone instance
jaw --home ~/project serve --port 3458  # run second instance
jaw orchestrate                   # enter PABCD
jaw dispatch --agent Research --task "..." # dispatch employee
jaw reset                         # full reset
```

---

## 🏗️ Multi-instance

Run isolated instances with separate settings, memory, and database.

```bash
jaw clone ~/my-project
jaw --home ~/my-project serve --port 3458
```

Each instance is fully independent — different working directory, different memory, different MCP config.

---

## 🐳 Docker

```bash
docker compose up -d       # → http://localhost:3457
```

Non-root `jaw` user, Chromium sandbox enabled. Two Dockerfiles: `Dockerfile` (npm install) and `Dockerfile.dev` (local source). Data persists in `jaw-data` named volume.

<details>
<summary>Docker details</summary>

```bash
# Dev build
docker build -f Dockerfile.dev -t cli-jaw:dev .
docker run -d -p 3457:3457 --env-file .env cli-jaw:dev

# Pin version
docker build --build-arg CLI_JAW_VERSION=1.0.1 -t cli-jaw:1.0.1 .

# If Chromium sandbox fails
docker run -e CHROME_NO_SANDBOX=1 -p 3457:3457 cli-jaw
```

</details>

---

## 📖 Documentation

| Document | What it covers |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | Release log, including the v1.6.0 catch-up covering v1.2.0 through v1.5.1 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, module graph, 95 API handlers across 94 endpoints |
| [TESTS.md](TESTS.md) | Test coverage, counts, and test plan |
| [memory-architecture.md](docs/memory-architecture.md) | 3-layer memory model, indexing, and runtime behavior |
| [env-vars.md](docs/env-vars.md) | Environment variable reference |
| [skill-router-plan.md](docs/skill-router-plan.md) | Skill routing architecture |
| [officecli-integration.md](docs/officecli-integration.md) | OfficeCLI setup for HWP/HWPX and Office documents |
| [devlog/structure/](devlog/structure/) | Internal architecture reference — prompt pipeline, agent spawn, frontend, server API, commands, Telegram, memory |

---

## ⚖️ How it compares

| | CLI-JAW | Hermes Agent | Claude Code |
|---|---|---|---|
| **Model access** | OAuth subscriptions (Claude Max, ChatGPT Pro, Copilot, Gemini) + OpenCode wildcard | API keys (OpenRouter 200+, Nous Portal) | Anthropic only |
| **Cost model** | Monthly subscriptions you already pay for | Per-token API billing | Anthropic subscription |
| **Primary UI** | Web PWA + Mac app + TUI | TUI only | CLI + IDE plugins |
| **Messaging** | Telegram (voice) + Discord | Telegram/Discord/Slack/WhatsApp/Signal | None |
| **Memory** | 3-layer (History/Flush/Soul) + FTS5 | Self-improving learning loop + Honcho | File-based auto-memory |
| **Browser automation** | Chrome CDP + vision-click + DOM ref | Limited | Via MCP |
| **Orchestration** | PABCD 5-phase FSM | Subagent spawn | Task tool |
| **Execution** | Local + Docker | Local/Docker/SSH/Daytona/Modal/Singularity | Local |
| **Skills** | 100+ bundled | Self-creating + agentskills.io | User-configured |
| **i18n** | English, Korean, Chinese | English | English |

CLI-JAW descends from the OpenClaw harness architecture (hybrid search manager, fallback patterns, session indexing). If migrating from OpenClaw, the slash-command surface and memory model will be familiar.

---

## 🛠️ Development

<details>
<summary>Build and project structure</summary>

```bash
npm run build          # tsc → dist/
npm run dev            # tsx server.ts (hot-reload)
```

```
src/
├── agent/          # AI agent lifecycle, spawn, history block
├── browser/        # Chrome CDP, vision-click, launch policy
├── cli/            # CLI registry, slash commands, model presets
├── core/           # DB, config, employees, logging
├── discord/        # Discord bot, commands, file send
├── http/           # Express server, middleware
├── memory/         # 3-layer memory, FTS5 indexing, flush, soul
├── messaging/      # Channel routing, session keys
├── orchestrator/   # PABCD state machine, worker registry, dispatch
├── prompt/         # Prompt assembly pipeline, templates
├── routes/         # REST API (95 handlers, 94 endpoints)
├── security/       # Input sanitization, path guards
└── telegram/       # Telegram bot, voice STT, forwarder
```

</details>

---

## 🧪 Tests

```bash
npm test             # tsx --test (native Node.js test runner)
```

See [TESTS.md](TESTS.md) for current inventory and pass counts.

---

## ❓ Troubleshooting

<details>
<summary>Common issues</summary>

| Problem | Solution |
|---|---|
| `cli-jaw: command not found` | `npm install -g cli-jaw` again. Check `npm bin -g` is in `$PATH` |
| `Error: node version` | Upgrade to Node.js 22+: `nvm install 22` |
| `NODE_MODULE_VERSION` mismatch | `npm run ensure:native` (auto-rebuild) |
| Agent timeout | `jaw doctor` to check CLI auth |
| `EADDRINUSE: port 3457` | Another instance running. Use `--port 3458` |
| Telegram not responding | Check token with `jaw doctor`. Ensure `jaw serve` is running |
| Skills not loading | `jaw skill reset` then `jaw mcp sync` |
| Browser commands fail | Install Chrome. Run `jaw browser start` first |

</details>

<details>
<summary>Fresh start — clean reinstall</summary>

```bash
npm uninstall -g cli-jaw
[ -d ~/.cli-jaw ] && mv ~/.cli-jaw ~/.cli-jaw.bak.$(date +%s)
npm install -g cli-jaw
jaw init
jaw doctor
```

</details>

<details>
<summary>Native module mismatch (better-sqlite3)</summary>

```bash
npm run ensure:native
# or: rm -rf node_modules package-lock.json && npm install
```

</details>

---

## 🤝 Contributing

1. Fork and branch from `master`
2. `npm run build && npm test`
3. Submit a PR

Found a bug or have an idea? [Open an issue](https://github.com/lidge-jun/cli-jaw/issues)

---

<div align="center">

**[MIT License](LICENSE)**

</div>
