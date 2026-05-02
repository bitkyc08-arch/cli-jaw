<div align="center">

# CLI-JAW

### 이미 결제한 AI 구독, 하나로 쓰세요.

[![npm](https://img.shields.io/npm/v/cli-jaw)](https://npmjs.com/package/cli-jaw)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](#-docker)

[English](README.md) / **한국어** / [中文](README.zh-CN.md) / [日本語](README.ja.md)

![CLI-JAW manager dashboard](docs/screenshots/manager-dashboard-light.png)

</div>

---

## CLI-JAW가 뭔가요?

Claude Code, Codex CLI, Gemini CLI, OpenCode, Copilot CLI — 요즘 터미널 AI 도구가 정말 많습니다. 근데 각각 앱이 따로 있고, 메모리도 따로 관리해야 하고, MCP 설정도 제각각이라 왔다 갔다 하다 보면 피로감이 장난이 아닙니다.

**CLI-JAW는 이 다섯 개 엔진을 하나의 인터페이스로 묶어주는 오픈소스 플랫폼입니다.** 별도의 API 키나 토큰 과금 없이, 여러분이 이미 결제하고 있는 구독(Claude Max, ChatGPT Pro, Gemini Advanced, Copilot 등)을 OAuth로 연결해서 그대로 쓰면 됩니다.

웹 대시보드, 터미널 TUI, Mac 앱, Telegram, Discord까지 — 어디서 쓰든 같은 메모리, 같은 스킬, 같은 비서입니다. 비개발자도 두 줄이면 설치할 수 있게 만들었습니다.

> **한 줄 요약**: 밴리스크 없는 Claude Code + Codex + Gemini CLI + OpenCode + Copilot CLI 통합 플랫폼. 다중 인스턴스 관리 + 노트 + 칸반까지 되는 슈퍼앱.

---

## 2.0.0에서 뭐가 달라졌나요

2.0.0은 CLI-JAW가 "개인 AI 비서"에서 "로컬 AI 운영 환경"으로 진화한 메이저 릴리스입니다.

### Manager Dashboard — 슈퍼앱

더 이상 터미널만 바라보고 있을 필요가 없습니다. 브라우저를 열면 모든 JAW 인스턴스를 한 눈에 볼 수 있습니다.

- 실행 중인 인스턴스를 그룹별로 보여주고, 각각의 상태를 실시간으로 추적합니다
- 선택한 인스턴스의 Web UI를 라이브 프리뷰로 바로 확인합니다
- 시작, 정지, 재시작을 딸깍 한 번으로 처리합니다
- CLI, 모델, 권한 모드, 작업 디렉터리 등 런타임 설정을 한 곳에서 확인합니다

### Notes Workspace — 짭시디언

대시보드 안에 마크다운 노트 시스템이 들어있습니다. 옵시디언까지는 아니지만 가볍게 쓰기엔 충분합니다.

- 폴더 트리, 드래그 앤 드롭 이동, 이름 변경
- Raw / Split / Preview 세 가지 보기 모드
- KaTeX 수식, Mermaid 다이어그램, 코드 하이라이팅 지원
- 저장하지 않은 변경 사항 표시 (dirty-state marker)

### Kanban Board

실행 중인 인스턴스를 카드로 만들어서 드래그할 수 있습니다. 프로젝트별로 인스턴스를 관리할 때 유용합니다.

### Employee 시스템

메인 CLI가 다른 CLI를 "직원"으로 부릅니다. 예를 들어 Claude가 Boss로 작업 계획을 세우고, Codex에게 백엔드 구현을 시키고, OpenCode에게 프론트엔드를 맡기는 식입니다. 각 직원은 독립된 CLI 세션에서 실행되고, 결과는 Boss에게 보고됩니다.

### 반응형 모바일 레이아웃

대시보드가 모바일에서도 잘 동작합니다. 폰에서 Telegram으로 대화하다가, 대시보드를 열어서 상태를 확인하는 식으로 쓸 수 있습니다.

---

## 두 줄이면 됩니다

```bash
npm install -g cli-jaw
jaw serve
```

브라우저에서 **http://localhost:3457** 을 열면 끝입니다.

**필요한 것**: Node.js 22 이상, AI CLI 인증 하나 이상 (아래 참조)

> npm이 뭔지 모르겠다면? [Node.js 공식 사이트](https://nodejs.org)에서 LTS 버전을 설치하면 npm이 같이 딸려옵니다.

> `jaw service install` 을 실행하면 부팅할 때 자동으로 시작됩니다 (macOS는 launchd, Linux는 systemd, Docker도 지원).

---

## 플랫폼별 설치

<details>
<summary><b>macOS — 터미널이 처음이라면</b></summary>

1. **Terminal**을 엽니다 (`Cmd + Space` -> `Terminal` 입력)
2. 아래 한 줄을 붙여넣고 Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install.sh | bash
```

3. 인증하고 시작:

```bash
copilot login
jaw serve        # -> http://localhost:3457
```

그냥 딸깍으로 켜지게 만들었습니다. Node.js, npm 설치까지 스크립트가 알아서 처리합니다.

</details>

<details>
<summary><b>Windows — WSL 원클릭 설치</b></summary>

**1단계: WSL 설치** (PowerShell을 관리자 권한으로 실행)

```powershell
wsl --install
```

재시작한 뒤 시작 메뉴에서 **Ubuntu**를 엽니다.

**2단계: CLI-JAW 설치**

```bash
curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install-wsl.sh | bash
```

**3단계: 시작**

```bash
source ~/.bashrc
copilot login    # 또는: claude auth / codex login / gemini
jaw serve        # -> http://localhost:3457
```

<details>
<summary>WSL 문제 해결</summary>

| 문제 | 해결 |
|---|---|
| `unzip: command not found` | 설치 스크립트를 다시 실행합니다 |
| `jaw: command not found` | `source ~/.bashrc` |
| Permission 에러 | `sudo chown -R $USER $(npm config get prefix)` |

</details>
</details>

<details>
<summary><b>Linux</b></summary>

```bash
# Node.js 22+ 설치 (nvm 사용)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22

# CLI-JAW 설치
npm install -g cli-jaw
jaw serve
```

</details>

---

## 인증 — 이미 쓰는 구독으로

하나만 있으면 됩니다. 이미 결제하고 있는 서비스를 골라서 인증하세요.

```bash
# 무료
copilot login        # GitHub Copilot (무료 티어 있음)
opencode             # OpenCode (무료 모델 사용 가능)

# 유료 (월 구독)
claude auth          # Claude Max 구독
codex login          # ChatGPT Pro 구독
gemini               # Gemini Advanced 구독
```

제대로 됐는지 확인하려면:

```bash
jaw doctor
```

<details>
<summary>jaw doctor 출력 예시</summary>

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

> **Claude Code 참고**: Anthropic computer-use MCP가 필요하면 native Claude installer 사용을 권장합니다 (`curl -fsSL https://claude.ai/install.sh | bash`). npm으로 설치한 Claude는 computer-use가 제한될 수 있는데, `jaw doctor`가 이런 상황을 알려줍니다.

---

## 대시보드 살펴보기

`jaw serve` 하나면 브라우저에서 모든 걸 할 수 있습니다. 대시보드는 CLI-JAW의 중심 제어판입니다.

### 어디서 쓸 수 있나요

CLI-JAW는 다섯 가지 Surface에서 동작합니다. 어디서 쓰든 같은 비서, 같은 메모리입니다.

| Surface | 설명 |
|---|---|
| **Web PWA** | 메인 인터페이스입니다. 마크다운, KaTeX, Mermaid 렌더링, 파일 드래그 앤 드롭, 음성 녹음, 다크/라이트 테마, 오프라인 캐시까지 지원합니다 |
| **Mac WebView 앱** | `jaw serve`를 macOS 네이티브 앱으로 감싼 것입니다. Dock에서 바로 접근할 수 있어서 브라우저를 따로 열 필요가 없습니다 |
| **Terminal TUI** | `jaw chat`으로 실행합니다. 멀티라인 편집, 슬래시 명령어 자동완성, 세션 유지를 지원합니다 |
| **Telegram** | 음성 메시지를 자동으로 텍스트로 변환합니다. 사진, 파일 업로드도 됩니다. 예약 작업 결과가 자동으로 전달됩니다 |
| **Discord** | 텍스트, 파일, 명령어를 지원합니다. 채널/스레드 라우팅과 에이전트 결과 포워딩이 됩니다 |

### 대시보드 구성

| 영역 | 하는 일 |
|---|---|
| **Navigator** | 활성/실행중/오프라인 인스턴스를 그룹으로 보여줍니다. CLI, 모델, 포트 정보와 함께 시작/정지/재시작 버튼을 제공합니다 |
| **Live Preview** | 선택한 인스턴스의 Web UI를 바로 임베드해서 보여줍니다. 따로 탭을 열 필요가 없습니다 |
| **Runtime Settings** | 현재 사용 중인 CLI, 모델, 추론 강도, 권한 모드, 작업 디렉터리, 직원 목록, 스킬 등을 한 눈에 보여줍니다 |
| **Notes** | 대시보드 안에 내장된 마크다운 노트입니다. 폴더 트리, KaTeX, Mermaid, 코드 하이라이팅, Split 프리뷰를 지원합니다 |

---

## 직원(Employee) 시스템

CLI-JAW에서 가장 흥미로운 기능 중 하나입니다. AI가 AI를 부려먹는 구조입니다.

### 어떻게 동작하나요

```
사용자 -> jaw 서버 -> Boss 에이전트 (메인 CLI)
                        ├── 직접 응답 (간단한 작업)
                        └── 직원 디스패치
                             ├── Frontend 직원 (OpenCode)
                             ├── Backend 직원 (Codex)
                             └── Research 직원 (Codex)
                                  └── 결과를 Boss가 취합해서 보고
```

- **Boss**가 작업 계획을 세우고, 각 **직원**에게 서브태스크를 배분합니다
- 각 직원은 독립된 CLI 세션에서 실행됩니다 (Claude, Codex, OpenCode 등 각자 다른 엔진 사용 가능)
- 파일 겹침 감지: 두 직원이 같은 파일을 건드리려 하면 경고합니다
- Boss는 직원 결과를 검토한 뒤 사용자에게 최종 보고합니다

### 디스패치 방법

```bash
jaw dispatch --agent "Backend" --task "API 엔드포인트 검증해줘"
```

Web UI, Telegram, Discord 어디서든 `/dispatch` 명령어로도 사용할 수 있습니다.

---

## 5개 AI 엔진

이미 결제하고 있는 OAuth 구독으로 라우팅합니다. **토큰당 과금이 없습니다.**

| CLI | 기본 모델 | 인증 | 비용 |
|---|---|---|---|
| **Claude** | `opus-4-6` | `claude auth` | Claude Max 구독 |
| **Codex** | `gpt-5.5` | `codex login` | ChatGPT Pro 구독 |
| **Gemini** | `gemini-3.1-pro-preview` | `gemini` | Gemini Advanced 구독 |
| **OpenCode** | `minimax-m2.7` | `opencode` | 무료 모델 사용 가능 |
| **Copilot** | `gpt-5-mini` | `copilot login` | 무료 티어 사용 가능 |

**Fallback 체인**: 한 엔진이 rate limit에 걸리거나 다운되면 다음 엔진이 자동으로 이어받습니다. `/fallback [cli1 cli2...]`로 순서를 설정합니다.

**OpenCode 와일드카드**: OpenRouter, 로컬 LLM, OpenAI 호환 API 등 어떤 모델 엔드포인트든 연결할 수 있습니다.

> 엔진 전환: `/cli codex` | 모델 전환: `/model gpt-5.5` | Web, Terminal, Telegram, Discord 어디서든 됩니다.

---

## PABCD 오케스트레이션

복잡한 작업을 할 때 "야 그냥 알아서 해" 하면 결과물이 좋지 않습니다. PABCD는 작업을 5단계로 쪼개서, 매 단계마다 사용자가 확인하고 승인하는 구조입니다.

```
P (Plan) -> A (Audit) -> B (Build) -> C (Check) -> D (Done) -> IDLE
   ⛔          ⛔           ⛔          auto         auto
```

| 단계 | 하는 일 |
|---|---|
| **P** (Plan) | Boss AI가 diff 수준의 구체적인 계획을 세웁니다. 사용자 확인을 위해 멈춥니다 |
| **A** (Audit) | 읽기 전용 워커가 계획의 실행 가능성을 검증합니다 (파일 경로, import, 시그니처 확인) |
| **B** (Build) | Boss가 직접 코드를 작성합니다. 워커는 결과만 검증합니다 |
| **C** (Check) | 타입 체크, 문서 업데이트, 일관성 검사를 자동으로 수행합니다 |
| **D** (Done) | 모든 변경 사항을 요약하고 IDLE로 돌아갑니다 |

상태는 DB에 저장되니까 서버를 재시작해도 이어서 작업할 수 있습니다. `jaw orchestrate` 또는 `/pabcd`로 시작합니다.

---

## 메모리 — 3계층 구조

AI 비서가 어제 한 이야기를 오늘도 기억하면 좋겠다고 생각해본 적 있으시죠? CLI-JAW는 세 가지 계층으로 기억을 관리합니다.

| 계층 | 뭘 저장하나요 | 어떻게 동작하나요 |
|---|---|---|
| **History Block** | 최근 세션 맥락 | 마지막 10개 세션(최대 8,000자)을 프롬프트 시작부에 자동 주입합니다 |
| **Memory Flush** | 대화에서 추출한 지식 | 10턴마다 대화를 요약해서 에피소드, 일일 로그(`YYYY-MM-DD.md`), 라이브 노트로 정리합니다 |
| **Soul + Task Snapshot** | 정체성과 의미 검색 | `soul.md`가 AI의 성격과 경계를 정의합니다. 매 프롬프트마다 FTS5 인덱스에서 관련 기억을 최대 4건 검색합니다 |

세 계층 모두 시스템 프롬프트에 자동으로 들어갑니다. 수동 검색도 가능합니다:

```bash
jaw memory search "지난주 회의 내용"
# 또는 어느 인터페이스에서든
/memory 지난주 회의 내용
```

Web UI 설정에서 프로필 요약, 메모리 마이그레이션, 재인덱싱도 할 수 있습니다.

---

## 스킬 — 100개 이상

CLI-JAW에는 100개 이상의 스킬이 탑재되어 있습니다. 스킬은 AI가 특정 작업을 수행하는 방법을 알려주는 가이드입니다.

| 분류 | 스킬 | 할 수 있는 것 |
|---|---|---|
| **오피스** | `pdf`, `docx`, `xlsx`, `pptx`, `hwp` | 문서 읽기, 생성, 편집. 한글(HWP/HWPX)도 됩니다 |
| **자동화** | `browser`, `vision-click`, `screen-capture`, `desktop-control` | Chrome 자동화, AI가 화면 보고 클릭, 스크린샷, 데스크톱 앱 제어 |
| **미디어** | `video`, `imagegen`, `lecture-stt`, `tts` | 영상 생성(Remotion), 이미지 생성(OpenAI), 강의 녹음 텍스트 변환, 음성 합성 |
| **연동** | `github`, `notion`, `telegram-send`, `memory` | GitHub Issue/PR/CI, Notion 페이지 관리, Telegram 미디어 전송, 메모리 관리 |
| **시각화** | `diagram` | 채팅 안에서 SVG 다이어그램, 차트, 인터랙티브 시각화를 바로 렌더링 |
| **개발 가이드** | `dev`, `dev-frontend`, `dev-backend`, `dev-data`, `dev-testing`, `dev-pabcd`, `dev-code-reviewer` | 서브 에이전트에 주입되는 엔지니어링 가이드라인 |

32개 활성 스킬은 항상 자동으로 주입되고, 194개 이상의 참조 스킬은 필요할 때 불러옵니다.

```bash
jaw skill install <name>    # 참조 스킬을 활성화
```

---

## 브라우저 & 데스크톱 자동화

| 기능 | 설명 |
|---|---|
| **Chrome CDP** | DevTools Protocol로 웹페이지를 탐색하고 클릭하고 입력하고 스크린샷을 찍습니다. 10가지 액션을 지원합니다 |
| **Vision-click** | 화면을 캡쳐하고 AI가 대상 좌표를 추출해서 클릭합니다. `jaw browser vision-click "로그인 버튼"` 한 줄이면 됩니다 |
| **DOM Reference** | ChatGPT, Grok, Gemini 웹 UI의 셀렉터 맵입니다. 모델 선택, 정지 버튼 등을 자동화할 수 있습니다 |
| **Computer Use** | Codex App의 Computer Use MCP를 통한 데스크톱 앱 자동화입니다. 웹은 CDP로, 데스크톱 앱은 Computer Use로 자동 라우팅됩니다 |
| **Diagram 스킬** | SVG 다이어그램과 인터랙티브 HTML 시각화를 생성해서 샌드박스 iframe에 렌더링합니다 |

---

## 메시징 — Telegram & Discord

### Telegram

```
📱 Telegram <-> 🦈 CLI-JAW <-> 🤖 AI Engines
```

<details>
<summary>설정 (3단계)</summary>

1. bot 만들기 — [@BotFather](https://t.me/BotFather)에서 `/newbot` -> 토큰 복사
2. 설정 — `jaw init --telegram-token YOUR_TOKEN` 또는 Web UI 설정에서 입력
3. bot에 아무 메시지나 보내면 Chat ID가 자동 저장됩니다

</details>

**Telegram에서 되는 것들**: 텍스트 채팅, 음성 메시지(자동 텍스트 변환), 사진/파일 업로드, 슬래시 명령어(`/cli`, `/model`, `/status`), 예약 작업 결과 자동 전달

### Discord

Telegram과 동일한 기능을 지원합니다. 채널/스레드 라우팅, 에이전트 결과 브로드캐스트 포워더가 있습니다. Web UI 설정에서 세팅합니다.

### 음성 & STT

Web(마이크 버튼), Telegram(음성 메시지), Discord에서 음성 입력이 됩니다. OpenAI 호환, Google Vertex AI, 커스텀 엔드포인트 등 다양한 STT 프로바이더를 지원합니다.

---

## MCP — 한 번 설치, 5개 엔진 동기화

[Model Context Protocol](https://modelcontextprotocol.io)은 AI에게 외부 도구를 쓸 수 있게 해주는 표준입니다. 보통이라면 Claude, Codex, Gemini, OpenCode, Copilot 설정 파일을 다섯 개 따로 편집해야 하는데, CLI-JAW에서는 한 번이면 됩니다.

```bash
jaw mcp install @anthropic/context7
# -> Claude, Codex, Gemini, OpenCode, Copilot 설정 파일에 동시에 동기화
```

JSON 파일 다섯 개를 돌아다니며 고칠 필요가 없습니다.

```bash
jaw mcp sync       # 수동으로 편집한 후 다시 동기화
```

---

## CLI 명령어

```bash
jaw serve                                # 서버 시작 -> http://localhost:3457
jaw chat                                 # 터미널 TUI
jaw doctor                               # 12가지 진단 체크
jaw service install                      # 부팅 시 자동 시작
jaw skill install <name>                 # 스킬 활성화
jaw mcp install <package>                # MCP 설치 -> 5개 엔진 동기화
jaw memory search <query>                # 메모리 검색
jaw browser start                        # Chrome 실행 (CDP)
jaw browser vision-click "로그인 버튼"     # AI 기반 클릭
jaw clone ~/project                      # 인스턴스 복제
jaw --home ~/project serve --port 3458   # 두 번째 인스턴스 실행
jaw orchestrate                          # PABCD 시작
jaw dispatch --agent Backend --task "..."  # 직원 디스패치
jaw reset                                # 전체 초기화
```

---

## 멀티 인스턴스 & Docker

### 멀티 인스턴스

프로젝트마다 독립된 인스턴스를 돌릴 수 있습니다. 설정, 메모리, DB가 전부 분리됩니다.

```bash
jaw clone ~/my-project
jaw --home ~/my-project serve --port 3458
```

### Docker

```bash
docker compose up -d       # -> http://localhost:3457
```

non-root `jaw` 유저, Chromium 샌드박스 활성화. Dockerfile이 두 개 있습니다: `Dockerfile` (npm install)과 `Dockerfile.dev` (로컬 소스). 데이터는 `jaw-data` named volume에 보존됩니다.

<details>
<summary>Docker 상세</summary>

```bash
# Dev 빌드
docker build -f Dockerfile.dev -t cli-jaw:dev .
docker run -d -p 3457:3457 --env-file .env cli-jaw:dev

# 버전 고정
docker build --build-arg CLI_JAW_VERSION=2.0.0 -t cli-jaw:2.0.0 .

# Chromium 샌드박스 문제 시
docker run -e CHROME_NO_SANDBOX=1 -p 3457:3457 cli-jaw
```

</details>

### 원격 접근 (Tailscale)

```bash
jaw serve --lan                       # 0.0.0.0 바인딩 + tailnet 피어 허용
```

Tailnet 피어는 WireGuard + IdP 인증을 거치므로 LAN처럼 취급됩니다. 자세한 설정은 영문 README의 [Remote access 섹션](README.md#-remote-access-tailscale)을 참고하세요.

---

## 개발

```bash
npm run build          # tsc -> dist/
npm run dev            # tsx server.ts (핫 리로드)
npm test               # Node.js 네이티브 테스트 러너
```

아키텍처와 테스트 상세는 [ARCHITECTURE.md](docs/ARCHITECTURE.md), [TESTS.md](TESTS.md), [devlog/structure/](devlog/structure/)에 있습니다.

---

## 문제 해결

| 문제 | 해결 방법 |
|---|---|
| `cli-jaw: command not found` | `npm install -g cli-jaw`를 다시 실행하세요. `npm bin -g`가 `$PATH`에 있는지 확인하세요 |
| `Error: node version` | Node.js 22 이상으로 업그레이드: `nvm install 22` |
| `NODE_MODULE_VERSION` mismatch | `npm run ensure:native` 실행 (자동 재빌드) |
| `EADDRINUSE: port 3457` | 다른 인스턴스가 실행 중입니다. `--port 3458`을 사용하세요 |
| Telegram/에이전트 인증 실패 | `jaw doctor` 실행 후 `jaw serve` 재시작 |
| 브라우저 명령 실패 | Chrome 설치 후 `jaw browser start`를 먼저 실행하세요 |

---

## 비교

| | CLI-JAW | Hermes Agent | Claude Code |
|---|---|---|---|
| **모델 접근** | OAuth 구독 (Claude Max, ChatGPT Pro, Copilot, Gemini) + OpenCode 와일드카드 | API 키 (OpenRouter 200+, Nous Portal) | Anthropic 전용 |
| **비용** | 이미 결제하는 월 구독 그대로 | 토큰당 API 과금 | Anthropic 구독 |
| **메인 UI** | Web PWA + Mac 앱 + TUI | TUI만 | CLI + IDE 플러그인 |
| **메시징** | Telegram (음성) + Discord | Telegram/Discord/Slack/WhatsApp/Signal | 없음 |
| **메모리** | 3계층 (History/Flush/Soul) + FTS5 | 자가 학습 루프 + Honcho | 파일 기반 자동 메모리 |
| **브라우저 자동화** | Chrome CDP + Vision-click + DOM ref | 제한적 | MCP 경유 |
| **오케스트레이션** | PABCD 5단계 FSM | 서브에이전트 스폰 | Task 도구 |
| **실행 환경** | 로컬 + Docker | 로컬/Docker/SSH/Daytona/Modal/Singularity | 로컬 |
| **스킬** | 100+ 번들 | 자가 생성 + agentskills.io | 유저 설정 |
| **다국어** | 영어, 한국어, 중국어, 일본어 | 영어 | 영어 |

---

## 기여하기

1. `master`에서 Fork하고 브랜치를 만듭니다
2. `npm run build && npm test`
3. PR을 제출합니다

버그를 발견했거나 아이디어가 있다면 [Issue를 열어주세요](https://github.com/lidge-jun/cli-jaw/issues).

---

<div align="center">

**[MIT License](LICENSE)**

비개발자도 운영할 수 있는 10만 LOC 오픈소스 AI 플랫폼.

</div>
