# CLI-Claw 테스트 계획

> 작성일: 2026-02-25
> 상태: 부분 구현 (2026-02-24 검증 반영)

## 계획 검증 결과 (2026-02-24)

- 현재 실행 중 테스트:
  - `tests/events.test.js`
  - `tests/events-acp.test.js`
  - `tests/telegram-forwarding.test.js`
- 이번 검증에서 반영한 보강:
  - `events.js`: `extractSessionId`, `extractFromEvent`, `extractToolLabels`, `extractFromAcpUpdate` 멀티-CLI 경로 테스트 추가
  - `telegram-forwarder.js`: skip/fallback 오탐 방지 assertion, markdown/chunk 유틸 테스트 추가
- 아직 미구현:
  - `cli-registry`, `bus`, `worklog`, `memory`, `commands`, `config`, `prompt` 테스트
  - fixture 확장(`codex-events.json`, `gemini-events.json`, `opencode-events.json`) 및 integration tier

## 프레임워크

- `node:test` + `node:assert` (Node.js 내장, 외부 의존성 0)
- `package.json`에 추가: `"test": "node --test tests/**/*.test.js"`

---

## 디렉토리 구조

```text
tests/
├── unit/                          ← Tier 1-2: 순수 함수 / 가벼운 의존성
│   ├── cli-registry.test.js       ← CLI_REGISTRY 구조, buildDefaultPerCli, buildModelChoicesByCli
│   ├── bus.test.js                ← broadcast, listener add/remove
│   ├── events.test.js             ← extractSessionId, extractFromEvent, extractToolLabels, dedupe
│   ├── events-acp.test.js         ← extractFromAcpUpdate (ACP 5가지 타입)
│   ├── worklog.test.js            ← createWorklog, appendToWorklog, updateMatrix, parseWorklogPending
│   ├── memory.test.js             ← search, read, save, appendDaily, loadMemoryForPrompt
│   └── commands-parse.test.js     ← parseCommand, scoreToken, sortCommands, formatDuration
├── integration/                   ← Tier 3: mock/stub 필요
│   ├── config.test.js             ← loadSettings, migrateSettings, detectCli
│   ├── prompt.test.js             ← getSystemPrompt, getSubAgentPromptV2
│   └── commands-dispatch.test.js  ← executeCommand (ctx 목 객체)
├── fixtures/                      ← CLI별 이벤트 샘플 JSON
│   ├── claude-events.json
│   ├── codex-events.json
│   ├── gemini-events.json
│   ├── opencode-events.json
│   └── acp-updates.json
└── helpers/
    └── tmp-home.js                ← 테스트용 임시 CLAW_HOME 유틸
```

---

## 티어 분류

### Tier 1 — 순수 함수 (의존성 0, 즉시 작성 가능)

| 모듈 | 테스트 파일 | 핵심 케이스 |
|------|------------|------------|
| `cli-registry.js` | `cli-registry.test.js` | 5개 CLI 키, 필수 필드, buildDefaultPerCli, buildModelChoicesByCli |
| `bus.js` | `bus.test.js` | listener add/remove/broadcast, WS 없어도 안전 |

### Tier 2 — 가벼운 I/O (tmp dir 격리)

| 모듈 | 테스트 파일 | 핵심 케이스 |
|------|------------|------------|
| `events.js` | `events.test.js` | extractSessionId (5 CLI), extractFromEvent (텍스트 추출), extractToolLabels (dedupe), extractFromAcpUpdate (5 타입) |
| `worklog.js` | `worklog.test.js` | 파일 생성/symlink, 섹션 삽입, 매트릭스 갱신, ⏳ 파싱 |
| `memory.js` | `memory.test.js` | save+read 라운드트립, grep 검색, daily 로그, 길이 제한 |
| `commands.js` | `commands-parse.test.js` | parseCommand, scoreToken, formatDuration |

### Tier 3 — Integration (모킹 필요)

| 모듈 | 테스트 파일 | 핵심 케이스 |
|------|------------|------------|
| `config.js` | `config.test.js` | 기본값, planning 마이그레이션, CLI 탐지 |
| `commands.js` | `commands-dispatch.test.js` | /help, /status, /version 핸들러 |
| `prompt.js` | `prompt.test.js` | 시스템 프롬프트 조립, 서브에이전트 프롬프트 |

### Tier 4 — E2E (후순위)

- `server.js` REST API 테스트
- `bin/` CLI 커맨드 테스트
- Telegram 연동 테스트

---

## 구현 옵션

| 옵션 | 범위 | 예상 시간 |
|------|------|----------|
| A | 구조 + 스켈레톤 | 10분 |
| B | A + Tier 1 완전 구현 + fixtures | 30분 |
| C | B + Tier 2 전체 구현 | 1시간 |

---

## 실행 명령

```bash
# 전체
npm test

# 단일 파일
node --test tests/unit/events.test.js

# watch 모드
node --test --watch tests/**/*.test.js
```
