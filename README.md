# 🦞 CLI-Claw

> Unified AI agent orchestration platform — CLI, Web UI, Telegram

## Quick Start

```bash
npm install -g cli-claw
cli-claw serve
# → http://localhost:3457
```

## Features

- 🤖 **Multi-CLI**: Claude Code, Codex, Gemini CLI, OpenCode 통합
- 👥 **Sub Agents**: 역할별 에이전트 분배 (프론트, 백엔드, QA 등)
- 📦 **Skills**: 플러그인 스킬 시스템 (2×3 분류: Active / Reference, Codex 폴백 번들)
- 🧠 **Memory**: 자동 대화 요약 + 장기 기억
- 💓 **Heartbeat**: 주기적 자동 실행
- 📬 **Telegram**: 텔레그램 봇 연동
- 🌐 **Browser**: Chrome CDP 기반 브라우저 제어
- 🔌 **MCP**: 글로벌 MCP 서버 관리 + 4개 CLI 자동 동기화

## CLI Commands

```
cli-claw serve                    # 서버 시작 (http://localhost:3457)
cli-claw chat                     # 터미널 채팅 TUI
cli-claw init                     # 초기화 마법사
cli-claw doctor                   # 진단 (11개 체크)
cli-claw status                   # 서버 상태 확인
```

### MCP 관리

```
cli-claw mcp                      # 등록된 MCP 서버 목록
cli-claw mcp install <pkg>        # 패키지 설치 + 등록 + 동기화
cli-claw mcp sync                 # mcp.json → 4개 CLI 동기화
cli-claw mcp reset [--force]      # 설정 초기화 + 재동기화
```

> `~/.cli-claw/mcp.json`을 소스로 Claude, Codex, Gemini CLI, OpenCode에 자동 변환·동기화합니다.

### 스킬 관리

```
cli-claw skill                    # 설치된 스킬 목록
cli-claw skill install <name>     # Codex 또는 GitHub에서 설치
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
cli-claw browser type <ref> <text># 텍스트 입력
cli-claw browser reset [--force]  # 프로필 + 스크린샷 초기화
```

> 💡 snapshot은 `locator.ariaSnapshot()` 기반으로 CDP 연결에서도 안정 동작합니다.

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
| `github-copilot/claude-sonnet-4.5` | Default        |
| `github-copilot/claude-opus-4.6`   | Copilot Opus   |
| `github-copilot/gpt-5`             | Copilot GPT-5  |
| `github-copilot/gemini-2.5-pro`    | Copilot Gemini |
| `opencode/big-pickle`              | 🆓 Free         |
| `opencode/GLM-5 Free`              | 🆓 Free         |
| `opencode/MiniMax M2.5 Free`       | 🆓 Free         |
| `opencode/Kimi K2.5 Free`          | 🆓 Free         |
| `opencode/GPT 5 Nano Free`         | 🆓 Free         |
| `opencode/Grok Code Fast 1 Free`   | 🆓 Free         |

> 💡 모든 CLI에서 **✏️ 직접 입력** 으로 모델 ID를 직접 타이핑할 수 있습니다.

## Architecture

```
cli-claw serve  →  Express + WebSocket server (:3457)
cli-claw chat   →  Terminal UI (raw stdin, footer, queue)
```

```
server.js            API routes + WebSocket hub
src/agent.js         CLI spawn + stream parser
src/orchestrator.js  Multi-agent task distribution
src/config.js        Settings + defaults
src/prompt.js        System prompt + sub-agent prompt generator
src/telegram.js      Telegram bot bridge
src/memory.js        Memory: MEMORY.md(시스템레벨 1500자) + session(10000자, threshold/2 간격 주입)
src/browser/         Chrome CDP control
lib/mcp-sync.js      MCP config sync (4 CLI targets)
public/              Web UI (ES Modules, stop/queue/drag-drop)
├── index.html       HTML skeleton (no inline JS/CSS)
├── css/             5 stylesheets (variables, layout, chat, sidebar, modals)
└── js/              12 modules (state, ws, ui, render + features/)
```

## MCP Auto-Install

`npm install -g cli-claw` 시 자동으로:

| Server   | 설치 방식                        |
| -------- | -------------------------------- |
| context7 | `npm i -g @upstash/context7-mcp` |

추가 서버는 `cli-claw mcp install <package>` 로 설치하세요.

## REST API

주요 엔드포인트:

| Category  | Endpoints                                                  |
| --------- | ---------------------------------------------------------- |
| Core      | `GET /api/session`, `POST /api/message`, `POST /api/stop`  |
| Settings  | `GET/PUT /api/settings`, `GET/PUT /api/prompt`             |
| Memory    | `GET/POST /api/memory`, `GET /api/claw-memory/search`      |
| MCP       | `GET/PUT /api/mcp`, `POST /api/mcp/sync,install,reset`     |
| Skills    | `GET /api/skills`, `POST /api/skills/enable,disable`       |
| Browser   | `POST /api/browser/start,stop,act,navigate,screenshot`     |
| Employees | `GET/POST /api/employees`, `PUT/DELETE /api/employees/:id` |
| Quota     | `GET /api/quota` (Claude/Codex/Gemini usage)               |

## License

ISC
