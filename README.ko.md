<div align="center">

# CLI-JAW

### 이미 결제한 AI 구독, 하나의 비서로.

[![npm](https://img.shields.io/npm/v/cli-jaw)](https://npmjs.com/package/cli-jaw)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](#-docker)

[English](README.md) / **한국어** / [中文](README.zh-CN.md)

<video src="https://github.com/user-attachments/assets/a7cf17c9-bfb3-44f0-b7fd-d001a39643fd" autoplay loop muted playsinline width="100%"></video>

</div>

<table>
<tr><td><b>기존 구독을 그대로 활용</b></td><td>Claude Max, ChatGPT Pro, Copilot, Gemini Advanced — OAuth 라우팅. OpenCode로 아무 모델이나 추가 가능. 토큰 과금 없음.</td></tr>
<tr><td><b>어디서든 접근</b></td><td>웹 PWA(가상 스크롤, WS 스트리밍) + Mac WebView 앱 + 터미널 TUI + Telegram(음성) + Discord — 5개 인터페이스, 하나의 대화.</td></tr>
<tr><td><b>3계층 메모리</b></td><td>History Block(최근 세션) + Memory Flush(에피소드, 일일 로그) + Soul & Task Snapshot(정체성, 시맨틱 검색). SQLite FTS5 전문 검색.</td></tr>
<tr><td><b>멀티에이전트 오케스트레이션</b></td><td>PABCD — DB 기반 5단계 FSM. Employee 시스템과 Worker 레지스트리. 파일 충돌 감지 병렬 실행. 모든 단계에서 사용자 승인 필요.</td></tr>
<tr><td><b>브라우저 및 데스크톱 자동화</b></td><td>Chrome CDP, vision-click, ChatGPT/Grok/Gemini DOM 레퍼런스, Codex App Computer Use 통합, diagram 스킬로 SVG/인터랙티브 시각화.</td></tr>
<tr><td><b>MCP 한 번 설치, 5개 엔진</b></td><td><code>jaw mcp install</code>로 Claude, Codex, Gemini, OpenCode, Copilot에 동시 동기화. 설정 파일 하나.</td></tr>
<tr><td><b>한국어 지원</b></td><td>한국어/영어/중국어 README. i18n 웹 UI. OfficeCLI를 통한 HWP/HWPX 한글 문서 지원.</td></tr>
</table>

---

## 빠른 링크

- [설치](#-설치--실행) · [인증](#-인증) · [인터페이스](#️-어디서-쓰나)
- [엔진 라우팅](#-엔진-라우팅) · [메모리](#-메모리) · [PABCD](#-오케스트레이션--pabcd) · [스킬](#-스킬)
- [브라우저 자동화](#-브라우저--데스크톱-자동화) · [MCP](#-mcp) · [메시징](#-메시징)
- [CLI 명령어](#️-cli-명령어) · [Docker](#-docker) · [문서](#-문서) · [비교](#️-비교)

---

## 🚀 설치 & 실행

```bash
npm install -g cli-jaw
jaw serve
```

**http://localhost:3457**을 열면 끝. Node.js 22+ 및 아래 AI CLI 중 하나 이상 인증 필요.

> `jaw service install` — 부팅 시 자동 시작 (systemd, launchd, Docker 자동 감지).

---

## 🔑 인증

하나만 있어도 됩니다. 이미 구독 중인 것을 선택하세요:

```bash
# 무료
copilot login        # GitHub Copilot
opencode             # OpenCode — 무료 모델 제공

# 유료 (월정액)
claude auth          # Anthropic Claude Max
codex login          # OpenAI ChatGPT Pro
gemini               # Google Gemini Advanced
```

상태 확인: `jaw doctor`

---

## 🖥️ 어디서 쓰나

5개 인터페이스에서 동일한 비서, 동일한 메모리, 동일한 스킬을 사용합니다.

| 인터페이스 | 기능 |
|---|---|
| **웹 PWA** | markdown/KaTeX/Mermaid 렌더링, 가상 스크롤, WS 스트리밍, 파일 드래그앤드롭, 음성 녹음, PABCD 로드맵 바, i18n(한국어/영어), 다크/라이트 테마, IndexedDB 오프라인 캐시 |
| **Mac WebView 앱** | `jaw serve`를 macOS 앱 셸로 감싼 것. 브라우저 없이 Dock에서 바로 접근 |
| **터미널 TUI** | 멀티라인 편집, 슬래시 명령어 자동완성, 오버레이 셀렉터, 세션 유지, 재개 분류 |
| **Telegram** | 음성 메시지(멀티 STT 프로바이더), 사진, 파일. 예약 작업 결과 자동 전송. `/cli`, `/model` 등 슬래시 명령어 |
| **Discord** | 텍스트/파일 메시징, 명령어 동기화, 채널/스레드 라우팅, 에이전트 결과 포워더 |

---

## 🔀 엔진 라우팅

이미 결제 중인 OAuth 월정액을 통해 5개 CLI 백엔드를 라우팅합니다. 토큰 단위 과금 없음.

| CLI | 기본 모델 | 인증 | 비용 |
|---|---|---|---|
| **Claude** | `claude-sonnet-4-6` | `claude auth` | Claude Max 구독 |
| **Codex** | `gpt-5.3-codex` | `codex login` | ChatGPT Pro 구독 |
| **Gemini** | `gemini-2.5-pro` | `gemini` | Gemini Advanced 구독 |
| **OpenCode** | `claude-opus-4-6-thinking` | `opencode` | 무료 모델 제공 |
| **Copilot** | `gpt-4.1` | `copilot login` | 무료 티어 제공 |

**폴백 체인**: 하나가 제한되거나 다운되면 다음 엔진이 자동으로 이어받음. `/fallback [cli1 cli2...]`로 설정.

**OpenCode 와일드카드**: OpenRouter, 로컬 LLM 등 아무 모델 엔드포인트나 연결 가능.

---

## 🧠 메모리

서로 다른 시간 범위를 담당하는 3계층 구조.

| 계층 | 저장 내용 | 동작 |
|---|---|---|
| **History Block** | 최근 세션 컨텍스트 | 최근 10개 세션, 최대 8000자, 작업 디렉토리 기준. 프롬프트 앞에 주입 |
| **Memory Flush** | 대화에서 추출한 구조화 지식 | 임계값(기본 10턴) 도달 시 트리거. 에피소드, 일일 로그(`YYYY-MM-DD.md`), 라이브 노트로 요약 |
| **Soul + Task Snapshot** | 정체성과 시맨틱 검색 | `soul.md`로 핵심 가치/톤/경계 정의. FTS5 인덱스에서 프롬프트당 최대 4개 관련 히트(700자) 검색 |

세 계층 모두 시스템 프롬프트에 자동 반영. `jaw memory search <query>` 또는 `/memory <query>`로 검색.

---

## 🎭 오케스트레이션 — PABCD

복잡한 작업을 위한 5단계 상태 머신. 모든 전환에 사용자 승인 필요.

```
P (Plan) → A (Audit) → B (Build) → C (Check) → D (Done) → IDLE
   ⛔         ⛔          ⛔         자동        자동
```

| 단계 | 동작 |
|---|---|
| **P** | Boss AI가 diff 수준 계획 작성. 검토를 위해 대기 |
| **A** | 읽기 전용 Worker가 계획의 실행 가능성 검증 |
| **B** | Boss가 구현. 읽기 전용 Worker가 결과 검증 |
| **C** | 타입 체크, 문서 갱신, 일관성 검사 |
| **D** | 전체 변경 요약. IDLE로 복귀 |

상태는 DB에 영속화되어 서버 재시작에도 유지. Worker는 파일 수정 불가. `jaw orchestrate` 또는 `/pabcd`로 활성화.

---

## 📦 스킬

100개 이상의 스킬, 용도별 정리.

| 카테고리 | 스킬 | 기능 |
|---|---|---|
| **오피스** | `pdf`, `docx`, `xlsx`, `pptx`, `hwp` | 문서 읽기/생성/편집. OfficeCLI를 통한 한글 HWP/HWPX |
| **자동화** | `browser`, `vision-click`, `screen-capture`, `desktop-control` | Chrome CDP, AI 좌표 클릭, macOS 스크린샷/카메라, Computer Use |
| **미디어** | `video`, `imagegen`, `lecture-stt`, `tts` | Remotion 비디오, OpenAI 이미지 생성, 강의 전사, 음성 합성 |
| **통합** | `github`, `notion`, `telegram-send`, `memory` | 이슈/PR/CI, Notion 페이지, Telegram 미디어, 영속 메모리 |
| **시각화** | `diagram` | SVG 다이어그램, 차트, 인터랙티브 시각화를 채팅에서 렌더링 |
| **개발 가이드** | `dev`, `dev-frontend`, `dev-backend`, `dev-data`, `dev-testing`, `dev-pabcd` | 서브에이전트 프롬프트에 주입되는 개발 가이드라인 |

22개 활성 스킬 (항상 주입). 94개 이상 참조 스킬 (요청 시 로드).

---

## 🌐 브라우저 & 데스크톱 자동화

| 기능 | 동작 |
|---|---|
| **Chrome CDP** | 탐색, 클릭, 타이핑, 스크린샷, JS 실행, 스크롤, 포커스, 키 입력 — DevTools Protocol 10개 액션 |
| **Vision-click** | 화면 캡처 → AI가 좌표 추출 → 클릭. `jaw browser vision-click "로그인 버튼"` |
| **DOM 레퍼런스** | ChatGPT, Grok, Gemini 웹 UI의 셀렉터 맵 — 모델 선택, 중지 버튼, 도구 드로어 |
| **Computer Use** | Codex App Computer Use MCP를 통한 데스크톱 앱 자동화 |
| **Diagram 스킬** | SVG 다이어그램/인터랙티브 HTML 시각화, 샌드박스 iframe에서 렌더링 |

---

## 🔌 MCP

[Model Context Protocol](https://modelcontextprotocol.io)은 AI 에이전트가 외부 도구를 사용할 수 있게 합니다. CLI-JAW는 5개 엔진의 MCP 설정을 하나의 파일로 관리합니다.

```bash
jaw mcp install @anthropic/context7
# → Claude, Codex, Gemini, OpenCode, Copilot 설정 파일에 동시 동기화
```

---

## 💬 메시징

### Telegram

설정 3단계: BotFather에서 봇 생성 → `jaw init --telegram-token` → 메시지 전송.

텍스트 채팅, 음성 메시지(자동 STT), 파일/사진 업로드, 슬래시 명령어, 예약 작업 결과 전송.

### Discord

Telegram과 동일 — 텍스트, 파일, 명령어. 채널/스레드 라우팅, 에이전트 결과 포워더. 웹 UI 설정에서 구성.

### 음성 & STT

웹(마이크 버튼), Telegram(음성 메시지), Discord에서 동작. OpenAI 호환, Google Vertex AI, 커스텀 엔드포인트 지원.

---

## ⏰ 스케줄링

| 기능 | 설명 |
|---|---|
| **Heartbeat 작업** | Cron 예약 작업을 무인 실행. Telegram/Discord로 결과 전달 |
| **서비스 자동 시작** | `jaw service install` — systemd, launchd, Docker 자동 감지 |

---

## ⌨️ CLI 명령어

```bash
jaw serve                         # 서버 시작
jaw chat                          # 터미널 TUI
jaw doctor                        # 12개 항목 진단
jaw service install               # 부팅 시 자동 시작
jaw skill install <name>          # 스킬 활성화
jaw mcp install <package>         # MCP 설치 → 5개 엔진 동기화
jaw memory search <query>         # 메모리 검색
jaw browser start                 # Chrome 실행 (CDP)
jaw browser vision-click "로그인" # AI 좌표 클릭
jaw clone ~/project               # 인스턴스 복제
jaw orchestrate                   # PABCD 진입
jaw reset                         # 전체 초기화
```

---

## 🐳 Docker

```bash
docker compose up -d       # → http://localhost:3457
```

비root `jaw` 사용자, Chromium 샌드박스 기본 활성화. `Dockerfile`(npm 설치)과 `Dockerfile.dev`(로컬 소스) 제공.

---

## 📖 문서

| 문서 | 내용 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 릴리스 로그 (v1.6.0 캐치업: v1.2.0~v1.5.1 포함) |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 시스템 설계, 모듈 그래프, 95개 API 핸들러 |
| [TESTS.md](TESTS.md) | 테스트 커버리지, 카운트, 계획 |
| [memory-architecture.md](docs/memory-architecture.md) | 3계층 메모리 모델, 인덱싱, 런타임 |
| [devlog/structure/](devlog/structure/) | 내부 아키텍처 레퍼런스 |

---

## ⚖️ 비교

| | CLI-JAW | Hermes Agent | Claude Code |
|---|---|---|---|
| **모델 접근** | OAuth 월정액 + OpenCode 와일드카드 | API 키 (OpenRouter 200+) | Anthropic 전용 |
| **비용** | 기존 월정액 | 토큰 단위 과금 | Anthropic 구독 |
| **주 UI** | 웹 PWA + Mac 앱 + TUI | TUI 전용 | CLI + IDE 플러그인 |
| **메시징** | Telegram(음성) + Discord | TG/Discord/Slack/WhatsApp/Signal | 없음 |
| **메모리** | 3계층 + FTS5 | 자기학습 루프 + Honcho | 파일 기반 |
| **브라우저** | CDP + vision-click + DOM ref | 제한적 | MCP 경유 |
| **오케스트레이션** | PABCD 5단계 FSM | 서브에이전트 스폰 | Task 도구 |

CLI-JAW는 OpenClaw 하네스 아키텍처(하이브리드 검색 매니저, 폴백 패턴, 세션 인덱싱)를 계승합니다.

---

## 🏗️ 멀티 인스턴스

별도의 설정, 메모리, 데이터베이스를 가진 독립 인스턴스를 실행할 수 있습니다.

```bash
jaw clone ~/my-project
jaw --home ~/my-project serve --port 3458
```

---

## 🛠️ 개발

<details>
<summary>빌드 및 프로젝트 구조</summary>

```bash
npm run build          # tsc → dist/
npm run dev            # tsx server.ts (핫 리로드)
```

```
src/
├── agent/          # AI 에이전트 생명주기, 스폰, History Block
├── browser/        # Chrome CDP, vision-click
├── cli/            # CLI 레지스트리, 슬래시 명령어, 모델 프리셋
├── core/           # DB, 설정, Employee, 로깅
├── discord/        # Discord 봇, 명령어, 파일 전송
├── memory/         # 3계층 메모리, FTS5 인덱싱, Flush, Soul
├── orchestrator/   # PABCD 상태 머신, Worker 레지스트리
├── routes/         # REST API (95개 핸들러, 94개 엔드포인트)
├── security/       # 입력 검증, 경로 보호
└── telegram/       # Telegram 봇, 음성 STT, 포워더
```

</details>

---

## 🧪 테스트

```bash
npm test             # tsx --test (Node.js 네이티브 테스트 러너)
```

[TESTS.md](TESTS.md)에서 현재 인벤토리와 통과 수 확인.

---

## ❓ 문제 해결

<details>
<summary>자주 발생하는 문제</summary>

| 문제 | 해결 |
|---|---|
| `cli-jaw: command not found` | `npm install -g cli-jaw` 재실행. `npm bin -g`가 `$PATH`에 있는지 확인 |
| `Error: node version` | Node.js 22+로 업그레이드: `nvm install 22` |
| `NODE_MODULE_VERSION` 불일치 | `npm run ensure:native` (자동 재빌드) |
| 에이전트 타임아웃 | `jaw doctor`로 CLI 인증 확인 |
| `EADDRINUSE: port 3457` | 다른 인스턴스 실행 중. `--port 3458` 사용 |
| Telegram 무응답 | `jaw doctor`로 토큰 확인. `jaw serve` 실행 중인지 확인 |
| 스킬 미로드 | `jaw skill reset` 후 `jaw mcp sync` |
| 브라우저 명령어 실패 | Chrome 설치. `jaw browser start` 먼저 실행 |

</details>

---

## 🤝 기여하기

1. `master`에서 포크 & 브랜치
2. `npm run build && npm test`
3. PR 제출

버그나 아이디어? [이슈 열기](https://github.com/lidge-jun/cli-jaw/issues)

---

<div align="center">

**[MIT License](LICENSE)**

</div>
