# 🦞 CLI-CLAW

> Unified AI agent orchestration platform — CLI, Web UI, Telegram

## Quick Start

```bash
npm install -g cli-claw
cli-claw serve
# → http://localhost:3457
```

## Features

- 🤖 **Multi-CLI**: Claude Code, Codex, Gemini CLI, OpenCode, **Copilot (ACP)** 통합
- 👥 **Sub Agents**: 역할별 에이전트 분배 (프론트, 백엔드, QA 등) + Phase-based 오케스트레이션 v2
- 📦 **Skills**: 플러그인 스킬 시스템 (2×3 분류: Active / Reference, 100개 내장)
- 🧠 **Memory**: 자동 대화 요약 + 장기 기억
- 💓 **Heartbeat**: 주기적 자동 실행
- 📨 **Telegram**: 텔레그램 봇 연동 + 슬래시 커맨드 디스패치 + origin 기반 포워딩
- 🌐 **Browser**: Chrome CDP 기반 브라우저 제어 + Vision Click (Codex only)
- 🔌 **MCP**: 글로벌 MCP 서버 관리 + **5개 CLI** 자동 동기화
- ⌨️ **Slash Commands**: CLI + Web + Telegram 통합 슬래시 커맨드 (자동완성, 드롭다운)
- 🔧 **CLI Registry**: 단일 소스 레지스트리 (`cli-registry.js`) — CLI/모델 추가 시 수정 1곳
- 🧪 **Tests**: 이벤트 파서 + Telegram 포워딩 회귀 방지 테스트 (`node --test`)

## CLI Commands

```
cli-claw serve                    # 서버 시작 (http://localhost:3457)
cli-claw chat                     # 터미널 채팅 TUI
cli-claw init                     # 초기화 마법사
cli-claw doctor                   # 진단 (11개 체크)
cli-claw status                   # 서버 상태 확인
cli-claw employee reset            # 직원 기본값 재설정 (5명)
```

### MCP 관리

```
cli-claw mcp                      # 등록된 MCP 서버 목록
cli-claw mcp install <pkg>        # 패키지 설치 + 등록 + 동기화
cli-claw mcp sync                 # mcp.json → 5개 CLI 동기화
cli-claw mcp reset [--force]      # 설정 초기화 + 재동기화
```

> `~/.cli-claw/mcp.json`을 소스로 Claude, Codex, Gemini CLI, OpenCode, **Copilot**에 자동 변환·동기화합니다.

### 스킬 관리

```
cli-claw skill                    # 설치된 스킬 목록
cli-claw skill install <name>     # Codex, skills_ref, 또는 GitHub에서 설치
cli-claw skill remove <name>      # 삭제
cli-claw skill info <name>        # SKILL.md 상세 보기
cli-claw skill reset [--force]    # 초기화 (2×3 분류 재실행)
```

### 메모리 관리

```
cli-claw memory search <query>    # 메모리 검색
cli-claw memory list              # 파일 목록
cli-claw memory read <file>       # 파일 읽기
cli-claw memory save <file>       # 파일 저장
```

### 브라우저 제어

```
cli-claw browser start            # Chrome 시작 (CDP)
cli-claw browser snapshot         # Accessibility tree (ariaSnapshot 기반)
cli-claw browser screenshot       # 스크린샷
cli-claw browser navigate <url>   # URL 이동
cli-claw browser click <ref>      # 클릭 (snapshot ref ID)
cli-claw browser mouse-click <x> <y>  # 픽셀 좌표 클릭
cli-claw browser vision-click "Login"  # 비전 AI 원커맨드 클릭 (DPR 자동 보정)
cli-claw browser type <ref> <text># 텍스트 입력
cli-claw browser reset [--force]  # 프로필 + 스크린샷 초기화
```

> 👁️ **Vision Click** (Codex): screenshot → AI 좌표 추출 → DPR 보정 → 클릭을 원커맨드로 실행. `--provider codex`, `--double` 옵션 지원. 자동 활성화 스킬.

### 테스트

```
npm test                          # 전체 테스트 (events + telegram)
npm run test:events               # 이벤트 파서 단위 테스트
npm run test:telegram             # Telegram 포워딩 테스트
npm run test:watch                # 감시 모드
```

## Supported Models

### Claude Code
| Model                       | Description                |
| --------------------------- | -------------------------- |
| `claude-sonnet-4-6`         | Default — fast, capable    |
| `claude-opus-4-6`           | Most powerful              |
| `claude-sonnet-4-6[1m]`     | Extended thinking (Sonnet) |
| `claude-opus-4-6[1m]`       | Extended thinking (Opus)   |
| `claude-haiku-4-5-20251001` | Fast, lightweight          |

### Codex
| Model                 | Description            |
| --------------------- | ---------------------- |
| `gpt-5.3-codex`       | Default — latest Codex |
| `gpt-5.3-codex-spark` | Lightweight            |
| `gpt-5.2-codex`       | Previous generation    |
| `gpt-5.1-codex-max`   | High context           |
| `gpt-5.1-codex-mini`  | Budget                 |

### Gemini CLI
| Model                    | Description      |
| ------------------------ | ---------------- |
| `gemini-3.0-pro-preview` | Latest preview   |
| `gemini-3.1-pro-preview` | Next gen preview |
| `gemini-2.5-pro`         | Default — stable |
| `gemini-3-flash-preview` | Fast preview     |
| `gemini-2.5-flash`       | Fastest          |

### OpenCode
| Model                              | Description    |
| ---------------------------------- | -------------- |
| `anthropic/claude-opus-4-6-thinking`   | Default        |
| `anthropic/claude-sonnet-4-6-thinking` | Sonnet         |
| `anthropic/claude-sonnet-4-6`          | Sonnet (fast)  |
| `openai/gpt-5.3-codex-xhigh`          | Codex xhigh    |
| `openai/gpt-5.3-codex-high`           | Codex high     |
| `opencode/big-pickle`                  | 🆓 Free         |
| `opencode/GLM-5 Free`                  | 🆓 Free         |
| `opencode/MiniMax M2.5 Free`           | 🆓 Free         |
| `opencode/Kimi K2.5 Free`              | 🆓 Free         |
| `opencode/GPT 5 Nano Free`             | 🆓 Free         |
| `opencode/Grok Code Fast 1 Free`       | 🆓 Free         |

### Copilot (ACP)
| Model                  | Cost    | Description              |
| ---------------------- | ------- | ------------------------ |
| `gpt-4.1`              | 🆓 Free | Default free model       |
| `gpt-5-mini`           | 🆓 Free | Free mini                |
| `claude-haiku-4.5`     | 0.33x   | Budget Claude            |
| `gpt-5.1-codex-mini`   | 0.33x   | Budget Codex             |
| `claude-sonnet-4.6`    | 1x      | Default — capable        |
| `gpt-5.3-codex`        | 1x      | Latest Codex             |
| `gemini-3-pro-preview` | 1x      | Gemini Pro               |
| `claude-opus-4.6`      | 3x      | Most powerful            |

> 💡 모든 CLI에서 **✏️ 직접 입력** 으로 모델 ID를 직접 타이핑할 수 있습니다.
> 
> 🔧 CLI/모델 추가는 `src/cli-registry.js` 1곳만 수정하면 백엔드/프론트엔드에 자동 반영됩니다.

## Architecture

```
cli-claw serve  →  Express + WebSocket server (:3457)
cli-claw chat   →  Terminal UI (raw stdin, footer, queue, 832L)
```

```
server.js              API routes + WebSocket hub + /api/cli-registry (854L)
src/cli-registry.js    CLI/model single source registry (87L) [NEW]
src/acp-client.js      Copilot ACP JSON-RPC client (243L) [NEW]
src/agent.js           CLI spawn + ACP branch + origin tracking (563L)
src/orchestrator.js    Orchestration v2 + triage + phase skip + origin (584L)
src/worklog.js         Worklog CRUD + phase matrix (153L)
src/config.js          Settings + CLI detection (175L)
src/prompt.js          System prompt + sub-agent v2 + phase skip (502L)
src/commands.js        Slash command registry + dispatcher (639L)
src/telegram.js        Telegram bot + forwarder lifecycle + origin (439L)
src/events.js          NDJSON parsing + dedupe + ACP update + trace (309L)
src/memory.js          Memory: MEMORY.md + session
lib/mcp-sync.js        MCP config sync (5 CLI targets) + symlink safe (645L)
tests/                 Event parser + Telegram forwarding tests [NEW]
public/                Web UI (ES Modules, 19 files)
├── index.html         HTML skeleton (no inline JS/CSS, 5 CLI options)
├── css/               5 stylesheets
└── js/                13 modules (state, ws, ui, render + features/)
bin/cli-claw.js        11개 서브커맨드 (serve/chat/init/doctor/status/mcp/skill/employee/memory/browser/reset)
```

## MCP Auto-Install

`npm install -g cli-claw` 시 자동으로:

| Server   | 설치 방식                        |
| -------- | -------------------------------- |
| context7 | `npm i -g @upstash/context7-mcp` |

추가 서버는 `cli-claw mcp install <package>` 로 설치하세요.

> **postinstall**: Copilot 바이너리 감지 시 `~/.local/bin/copilot` PATH 심링크 자동 생성

## REST API

주요 엔드포인트:

| Category  | Endpoints                                                            |
| --------- | -------------------------------------------------------------------- |
| Core      | `GET /api/session`, `POST /api/message`, `POST /api/stop`            |
| Registry  | **`GET /api/cli-registry`** — CLI/모델 단일 소스                     |
| Orchestr  | `POST /api/orchestrate/continue`, `POST /api/employees/reset`        |
| Commands  | `POST /api/command`, `GET /api/commands?interface=`                  |
| Settings  | `GET/PUT /api/settings`, `GET/PUT /api/prompt`                       |
| Memory    | `GET/POST /api/memory`, `GET /api/claw-memory/search`                |
| MCP       | `GET/PUT /api/mcp`, `POST /api/mcp/sync,install,reset`               |
| Skills    | `GET /api/skills`, `POST /api/skills/enable,disable`                 |
| Browser   | `POST /api/browser/start,stop,act(+mouse-click),navigate,screenshot` |
| Employees | `GET/POST /api/employees`, `PUT/DELETE /api/employees/:id`           |
| Quota     | `GET /api/quota` (Claude/Codex/Gemini/**Copilot** usage)                     |

## License

ISC
