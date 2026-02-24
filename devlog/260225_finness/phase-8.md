# Phase 8 (finness): 백엔드 구조 개선 — dev 스킬 기반 코드 감사

> 목표: `skills_ref/dev*` 4개 스킬 기준으로 코드베이스 위반·개선점 도출 (프런트엔드 제외)
> 감사 대상: `server.js`, `src/*.js`, `src/browser/*.js`, `tests/`
> 감사 기준: `dev` (모듈화, 안전), `dev-backend` (API, 에러), `dev-data` (파이프라인), `dev-testing` (테스트)

---

## 진단 요약

| 영역 | 위반 건수 | 심각도 | 스킬 근거 |
|------|----------|--------|-----------|
| **500줄 초과** | 5개 파일 | 🔴 높음 | `dev` §1 |
| **조용한 catch** | 43건 | 🟡 중간 | `dev` §5, `dev-backend` §에러핸들링 |
| **단일 책임 위반** | 3개 파일 | 🔴 높음 | `dev` §1 |
| **테스트 커버리지 부족** | 6개 핵심 모듈 미테스트 | 🟡 중간 | `dev-testing` |
| **API 응답 불일치** | 일부 라우트 | 🟢 낮음 | `dev-backend` §API설계 |
| **하드코딩 설정값** | 산발적 | 🟢 낮음 | `dev` §5 |

---

## 1. 파일 크기 위반 (500줄 룰)

> `dev` §1: "단일 파일 **500줄 초과 금지**. 넘으면 분리."

| 파일 | 줄 수 | 초과량 | 분리 방안 |
|------|-------|--------|----------|
| `server.js` | **856** | +356 | 라우트 그룹별 분리 (아래 상세) |
| `src/commands.js` | **639** | +139 | 핸들러 → `src/command-handlers.js` 분리 |
| `src/agent.js` | **585** | +85 | `spawnAgent` (328줄) → `src/spawn.js` 분리 |
| `src/orchestrator.js` | **584** | +84 | subtask JSON 파서 → `src/subtask-parser.js` 분리 |
| `src/prompt.js` | **502** | +2 | 경계선이지만 섹션별로 정리 가능 |

### 1.1 `server.js` 분리 계획 (856줄 → 5파일)

현재 `server.js`에 혼재된 책임:

```
server.js (856줄)
├── Quota 읽기 (readClaudeCreds, fetchClaudeUsage, ...)     ~80줄
├── Express + WebSocket 세팅                                 ~50줄
├── session/message API 라우트                               ~30줄
├── settings API 라우트                                      ~50줄
├── memory API 라우트                                        ~50줄
├── employee API 라우트                                      ~50줄
├── telegram send API                                        ~50줄
├── MCP API 라우트                                           ~50줄
├── heartbeat API 라우트                                     ~30줄
├── command 실행 API                                         ~40줄
├── skills/browser/quota API                                 ~80줄
├── 서버 부팅 + Telegram init                                ~50줄
└── 기타 헬퍼 (seedDefaultEmployees, makeWebCommandCtx 등)   ~100줄
```

**분리안:**

| 새 파일 | 내용 | 예상 크기 |
|---------|------|----------|
| `src/routes/api.js` | session, messages, command, orchestrate, stop, clear | ~80줄 |
| `src/routes/settings.js` | settings, prompt, a2 파일 CRUD | ~60줄 |
| `src/routes/resources.js` | memory, employees, heartbeat, skills, browser | ~120줄 |
| `src/routes/integrations.js` | telegram send, MCP CRUD, quota | ~120줄 |
| `server.js` (잔여) | Express init, WS, 부팅, import 연결 | ~200줄 |

### 1.2 `commands.js` 분리 계획 (639줄)

```
commands.js (639줄)
├── 유틸함수 (sort, score, normalize, ...)       ~160줄
├── 핸들러 15개 (help, status, model, ...)       ~320줄  ← 분리 대상
├── COMMANDS 레지스트리 배열                      ~80줄
└── parseCommand, executeCommand, completions     ~80줄
```

**분리안:**

| 새 파일 | 내용 | 예상 크기 |
|---------|------|----------|
| `src/command-handlers.js` | 15개 핸들러 함수 | ~320줄 |
| `src/commands.js` (잔여) | 레지스트리, 파서, 자동완성 | ~320줄 |

---

## 2. 조용한 에러 핸들링 (43건)

> `dev` §5: "에러 핸들링: `try/catch` 필수, **조용한 실패 금지** (최소 `console.error`)"
> `dev-backend` §에러핸들링: "모든 async 핸들러에 `try/catch` 필수"

### 파일별 분포

| 파일 | `catch { }` 건수 | 위험도 |
|------|-----------------|--------|
| `src/prompt.js` | 12 | 🟢 대부분 초기화 시 안전한 fallback |
| `src/orchestrator.js` | 7 | 🟡 JSON 파싱 실패 시 subtask 누락 가능 |
| `src/agent.js` | 4 | 🟡 프로세스 kill 실패 무시 |
| `src/telegram.js` | 5 | 🟡 봇 재시작 에러 무시 |
| `src/config.js` | 3 | 🟢 설정 로드 fallback |
| `src/acp-client.js` | 2 | 🟢 JSON 파싱, shutdown |
| 기타 | 10 | 혼합 |

### 조치안

- **위험한 catch**: `orchestrator.js`, `agent.js`, `telegram.js`의 조용한 catch에 **최소 `console.warn('[module:catch]', e.message)`** 추가
- **안전한 catch**: `prompt.js`, `config.js`의 초기화 fallback은 주석으로 의도 명시 (`/* expected: file not ready */`)
- **기준**: catch 안에서 에러를 완전 무시하는 경우 최소 `console.debug` 레벨 로깅 추가

---

## 3. 테스트 커버리지 부족

> `dev-testing` SKILL: 테스트 작성 가이드 + Playwright 기반 E2E

### 현재 테스트 현황

| 테스트 파일 | 대상 모듈 | 상태 |
|------------|----------|------|
| `tests/events.test.js` | `src/events.js` | ✅ 존재 |
| `tests/events-acp.test.js` | `src/events.js` (ACP) | ✅ 존재 |
| `tests/telegram-forwarding.test.js` | `src/telegram-forwarder.js` | ✅ 존재 |
| `tests/acp-client.test.js` | `src/acp-client.js` | ✅ 존재 |
| `tests/unit/bus.test.js` | `src/bus.js` | ✅ 존재 |
| `tests/unit/cli-registry.test.js` | `src/cli-registry.js` | ✅ 존재 |
| `tests/unit/commands-parse.test.js` | `src/commands.js` (파서) | ✅ 존재 |
| `tests/unit/frontend-constants.test.js` | 프론트 상수 | ✅ 존재 |
| `tests/unit/worklog.test.js` | `src/worklog.js` | ✅ 존재 |

### 미테스트 핵심 모듈

| 모듈 | 줄 수 | 테스트 | 위험도 | 권장 테스트 |
|------|-------|--------|--------|------------|
| `src/agent.js` | 585 | ❌ | 🔴 | `spawnAgent` args 빌드, 큐 관리, 메모리 flush |
| `src/orchestrator.js` | 584 | ❌ | 🔴 | subtask 파싱, 오케스트레이션 로직, stripSubtaskJSON |
| `src/config.js` | 177 | ❌ | 🟡 | settings 마이그레이션, CLI 감지 |
| `src/prompt.js` | 502 | ❌ | 🟡 | 시스템 프롬프트 조립, 스킬 병합 |
| `src/commands.js` (핸들러) | 639 | ❌ | 🟡 | 핸들러 15개 (model, cli, fallback 등) |
| `server.js` (라우트) | 856 | ❌ | 🟡 | API 라우트 응답 형식, 에러 케이스 |

### 권장 추가 테스트 (우선순위순)

1. **`tests/unit/orchestrator.test.js`** — `stripSubtaskJSON`, subtask 파싱 정확성
2. **`tests/unit/agent-args.test.js`** — `buildArgs`, `buildResumeArgs` CLI별 인자 생성
3. **`tests/unit/config.test.js`** — `migrateSettings`, `loadSettings` merge 로직
4. **`tests/unit/commands-handlers.test.js`** — 핸들러별 정상/에러 응답

---

## 4. API 응답 형식 불일치

> `dev-backend` §API설계: 일관된 `{ ok: true, data: {...} }` / `{ ok: false, error: '...' }` 형식

### 현재 불일치

| 라우트 | 현재 응답 | 기대 응답 |
|--------|----------|----------|
| `GET /api/session` | `{ sessionId, ... }` (bare) | `{ ok: true, data: { sessionId, ... } }` |
| `GET /api/messages` | `[{...}, ...]` (bare array) | `{ ok: true, data: [...] }` |
| `GET /api/employees` | `[{...}, ...]` (bare array) | `{ ok: true, data: [...] }` |
| `GET /api/memory` | `[{...}, ...]` (bare array) | `{ ok: true, data: [...] }` |
| `POST /api/stop` | `{ ok: true, killed }` | ✅ 올바름 |
| `POST /api/clear` | `{ ok: true }` | ✅ 올바름 |
| `POST /api/command` | `{ ok, text, ... }` | ✅ 올바름 |

> ⚠️ 이 변경은 **프런트엔드 코드도 함께 수정**해야 하므로, 프런트 개선 작업과 동시에 진행하거나 하위호환 래퍼(`data` 필드 추가하되 기존 필드 유지)를 도입

---

## 5. 하드코딩 설정값

> `dev` §5: "설정값은 하드코딩 금지 → `config.js` 또는 `settings.json` 사용"

| 위치 | 하드코딩 값 | 권장 |
|------|-----------|------|
| `server.js:72` | `PORT = 3457` | 이미 `process.env.PORT` fallback 사용 → ✅ |
| `src/agent.js` | `maxSessions = 5`, `maxTotalChars = 8000` | `config.js`로 이동 |
| `src/orchestrator.js` | 타임아웃, 재시도 횟수 | `config.js`로 이동 |
| `src/memory.js` | flush 간격 등 | 이미 `settings.memory.flushEvery` 사용 → ✅ |

---

## 6. 데이터 파이프라인 패턴 (dev-data 관점)

> `dev-data` §데이터처리: "스키마 우선, 방어적 파싱, 파이프라인 사고"

### 현재 상태

| 영역 | 평가 |
|------|------|
| SQLite (better-sqlite3) | ✅ prepared statement 사용, `src/db.js`에 집중 |
| JSON 파싱 | 🟡 방어적 try/catch는 있으나 스키마 검증 없음 |
| 설정 파일 | 🟡 `loadSettings`에서 deep merge는 하지만 스키마 불일치 시 조용한 동작 |
| worklog | ✅ `src/worklog.js`로 분리, 파이프라인 패턴 준수 |

### 조치안

- `loadSettings`에 **최소 필수 필드 검증** 추가 (cli, permissions 등)
- ACP/이벤트 JSON 파싱에 **Zod 또는 수동 assert** 적용 검토 (오버엔지니어링 주의)

---

## 수정 우선순위

### P0: 구조 안정화 (1~2일)

1. **`server.js` 라우트 분리** — 856줄 → ~200줄 + 4개 라우트 파일
2. **`commands.js` 핸들러 분리** — 639줄 → ~320줄 + 핸들러 파일
3. **조용한 catch 43건 → 최소 로깅 추가** (1~2시간)

### P1: 테스트 확충 (2~3일)

4. **`tests/unit/orchestrator.test.js`** — subtask 파싱 3~5 케이스
5. **`tests/unit/agent-args.test.js`** — CLI별 인자 빌드 5~7 케이스
6. **`tests/unit/config.test.js`** — 설정 마이그레이션/병합 3~5 케이스

### P2: 정합성 (3~5일)

7. **API 응답 래퍼 통합** — GET 라우트에 `{ ok, data }` 래핑 (프런트와 동기 진행)
8. **하드코딩 상수 → config.js 승격** — agent/orchestrator 설정값
9. **`agent.js` spawnAgent 분리** — 585줄 → ~250줄 + `src/spawn.js`

---

## 난이도

| 항목 | 난이도 |
|------|--------|
| **종합** | **★★★☆☆ (중)** |
| 예상 시간 | **4~6일** (P0~P2 전체) |
| 위험도 | **중간** — 라우트 분리는 import 경로만 바뀌므로 낮음, API 응답 변경은 프런트 동기 필요 |

---

## Phase 0~7 과의 관계

| 기존 Phase | 이 Phase와의 관계 |
|-----------|-----------------|
| Phase 0 (이벤트 정규화) | ✅ 완료 — events.js 이미 정리됨 |
| Phase 1 (Telegram lifecycle) | 이 Phase에서 조용한 catch 정리 시 telegram.js도 대상 |
| Phase 3 (사이트 프라이프 보호) | 독립 |
| Phase 4 (CLI/모델 단일소스) | ✅ 완료 — cli-registry.js 분리됨 |
| Phase 5 (회귀 테스트) | 이 Phase P1이 테스트 확충의 후속 작업 |
| Phase 6~7 (테마/i18n) | 프런트엔드 전용 — **이 Phase와 병행 가능** |
