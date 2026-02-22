# 🦞 CLI-Claw

CLI 래핑 기반 AI 시스템 에이전트. Claude Code, Codex, Gemini CLI를 단일 인터페이스로 제어.
Web UI + Telegram + CLI 터미널에서 동시 접근 가능.

## Quick Start

```bash
git clone git@github.com:bitkyc08-arch/cli-claw.git
cd cli-claw
npm install

# 초기 설정 (대화형)
node bin/cli-claw.js init

# 서버 시작
node bin/cli-claw.js serve
# → http://localhost:3457
```

## CLI Commands

```bash
cli-claw serve [--port 3457] [--open]   # 서버 시작 (포그라운드)
cli-claw init  [--non-interactive]       # 초기 설정 마법사
cli-claw doctor [--json]                 # 설치/설정 진단
cli-claw chat  [--raw]                   # 터미널 채팅 (REPL / ndjson)
cli-claw status                          # 서버 상태 확인
```

## Architecture

```
┌─────────────┐     ┌──────────┐     ┌──────────────┐
│  🌐 Web UI  │────▶│          │────▶│ Claude Code  │
│  📱 Telegram│────▶│ Gateway  │────▶│ Codex        │
│  📟 CLI     │────▶│ (server) │────▶│ Gemini CLI   │
└─────────────┘     └──────────┘     └──────────────┘
                         │
                    ┌────┴────┐
                    │ SQLite  │
                    │ + 💓    │
                    │Heartbeat│
                    └─────────┘
```

## Data Paths

```
~/.cli-claw/
├── settings.json      ← 서버 설정
├── claw.db            ← 대화 히스토리 (SQLite)
├── heartbeat.json     ← 예약 작업 (AI/UI/사람 편집 가능)
├── skills/            ← 에이전트 스킬
└── prompts/
    ├── A-1.md         ← 코어 시스템 프롬프트 (불변)
    ├── A-2.md         ← 유저 설정 (UI에서 수정)
    ├── B.md           ← 합성 프롬프트 (자동)
    └── HEARTBEAT.md   ← 주기적 체크리스트
```

## Features

| 기능            | 설명                                        |
| --------------- | ------------------------------------------- |
| 🤖 Multi-CLI     | Claude, Codex, Gemini, OpenCode 지원        |
| 🎯 Orchestration | Planning agent → Sub-agent 배분 → 평가 루프 |
| 📱 Telegram      | 봇 연동, 양방향 메시지                      |
| 💓 Heartbeat     | 다중 예약 작업 (UI + 파일 편집 + AI 편집)   |
| 🌐 Web UI        | 실시간 채팅 + 설정 + 에이전트 관리          |
| 📟 CLI Chat      | 터미널 REPL + `--raw` ndjson 파이프         |
| 🔗 Symlink       | `.agents/skills/` 자동 연결                 |

## API

| Method  | Path              | Description        |
| ------- | ----------------- | ------------------ |
| GET     | `/api/session`    | 세션 상태          |
| GET     | `/api/messages`   | 메시지 히스토리    |
| POST    | `/api/message`    | 메시지 전송        |
| GET/PUT | `/api/settings`   | 설정 CRUD          |
| GET/PUT | `/api/heartbeat`  | 하트비트 jobs CRUD |
| GET/PUT | `/api/prompt`     | A-2 프롬프트       |
| GET     | `/api/cli-status` | CLI 설치 상태      |

## Requirements

- **Node.js 22+**
- Claude Code / Codex / Gemini CLI 중 1개 이상 설치 + 인증
- (선택) Telegram Bot Token

## Roadmap

| Phase | 내용                                   | 상태 |
| ----- | -------------------------------------- | ---- |
| 1-3   | Foundation + Agent + Prompt            | ✅    |
| 4     | Web UI                                 | ✅    |
| 5     | Orchestration (Planning + Sub-agents)  | ✅    |
| 6     | Telegram Bot                           | ✅    |
| 7     | Integration Test                       | ✅    |
| 8     | Heartbeat (Multi-job + Symlink)        | ✅    |
| 9     | CLI Packaging (serve/init/doctor/chat) | ✅    |
| 10    | 사진 인풋                              | ⬜    |
| 11    | 메모리                                 | ⬜    |
