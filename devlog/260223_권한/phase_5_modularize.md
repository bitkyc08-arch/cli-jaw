# Phase 5 — server.js 모듈 분리

## 현재 상태

`server.js` = **1800줄, 83개 함수, 단일 파일**.
기여자가 보면 도망감. 모듈 분리가 퍼블리시 전 필수.

---

## 분리 전략: 기능 단위 6개 모듈

현재 `server.js`의 코드 섹션 매핑:

```
server.js (1800 lines)
│
├─ L1-39     imports + .env loader
├─ L40-165   config, paths, prompts (A-1, A-2, HEARTBEAT)
├─ L166-262  prompt generation (getSystemPrompt, regenerateB, loadRecentMemories)
├─ L263-329  settings (load, save, migrate, defaults)
├─ L330-407  database (schema, prepared statements, helpers)
├─ L408-513  CLI detection + quota (detectCli, readClaudeCreds, fetchUsage...)
├─ L514-864  agent spawn (spawnAgent, buildArgs, kill, steer, queue, memory flush, upload)
├─ L865-972  event extraction (extractFromEvent, extractToolLabel, extractSessionId)
├─ L973-1118 orchestration (orchestrate, parseSubtasks, distributeAndWait)
├─ L1119-1405 Express routes + WebSocket (20+ endpoints)
├─ L1405-1668 Telegram (initTelegram, tgOrchestrate, helpers)
├─ L1669-1780 heartbeat (timers, fs.watch, jobs)
└─ L1781-1800 server.listen + boot
```

---

## 모듈 구성

### `src/db.js` (~100줄)
```
FROM server.js L330-407
```
- Database 초기화 (schema, WAL pragma)
- Prepared statements: `getSession`, `updateSession`, `insertMessage`, `getMessages`, `getRecentMessages`, `clearMessages`
- Memory statements: `getMemory`, `upsertMemory`, `deleteMemory`
- Employee statements: `getEmployees`, `insertEmployee`, `deleteEmployee`

**export**: `db`, 모든 prepared statement 함수, `DB_PATH`

**의존**: `better-sqlite3`, config paths

---

### `src/prompt.js` (~120줄)
```
FROM server.js L78-262
```
- `A1_CONTENT`, `A2_DEFAULT`, `HEARTBEAT_DEFAULT` (문자열 상수)
- `getMemoryDir()`, `loadRecentMemories()`
- `getSystemPrompt()` — A-1 + A-2 + employees + memories + heartbeat 합성
- `regenerateB()` — B.md 파일 쓰기 + 세션 무효화

**export**: `getSystemPrompt`, `regenerateB`, `getMemoryDir`, 경로 상수

**의존**: `db.js` (getSession, updateSession, getEmployees), `settings`, `heartbeat.js` (loadHeartbeatFile)

---

### `src/agent.js` (~320줄)
```
FROM server.js L514-864
```
- `activeProcess`, `memoryFlushCounter` 상태
- `killActiveAgent()`, `waitForProcessEnd()`, `steerAgent()`
- `messageQueue`, `enqueueMessage()`, `processQueue()`
- `makeCleanEnv()`, `buildArgs()`, `buildResumeArgs()`
- `spawnAgent()` (160줄 — 핵심 함수)
- `triggerMemoryFlush()` (~55줄)
- `saveUpload()` wrapper

**export**: `spawnAgent`, `killActiveAgent`, `steerAgent`, `enqueueMessage`, `processQueue`, `activeProcess` (getter), `buildArgs`, `buildResumeArgs`

**의존**: `db.js`, `prompt.js`, `events.js`, `broadcast` (from server.js)

> ⚠️ `spawnAgent`이 `broadcast`, `insertMessage`, `getSession` 등 다수 의존. `broadcast`를 콜백으로 주입하거나, 이벤트 버스 패턴 필요.

---

### `src/events.js` (~110줄)
```
FROM server.js L865-972
```
- `extractSessionId(cli, event)`
- `extractFromEvent(cli, event, ctx, agentLabel)` — broadcast 호출
- `extractToolLabel(cli, event)`

**export**: 3개 함수 전부

**의존**: `broadcast` (콜백 주입 필요)

---

### `src/orchestrator.js` (~150줄)
```
FROM server.js L973-1118
```
- `MAX_ROUNDS` 상수
- `parseSubtasks(text)`
- `stripSubtaskJSON(text)`
- `distributeAndWait(subtasks)` — employee별 spawnAgent
- `orchestrate(prompt)` — planning → distribute → summarize 루프

**export**: `orchestrate`, `parseSubtasks`, `stripSubtaskJSON`

**의존**: `agent.js` (spawnAgent), `db.js` (getEmployees, insertMessage), `prompt.js` (getSystemPrompt), `broadcast`

---

### `src/telegram.js` (~270줄)
```
FROM server.js L1405-1668
```
- `escapeHtmlTg()`, `markdownToTelegramHtml()`, `chunkTelegramMessage()`
- `orchestrateAndCollect(prompt)` — Promise wrapper
- `telegramBot`, `telegramActiveChatIds` 상태
- `initTelegram()` (190줄) — bot setup, handlers, photo/voice/document processing, ipv4Fetch

**export**: `initTelegram`, `orchestrateAndCollect`

**의존**: `grammy`, `orchestrator.js`, `broadcast` 리스너, `settings`, `upload.js`

---

### `src/heartbeat.js` (~115줄)
```
FROM server.js L1669-1780
```
- `heartbeatTimers`, `heartbeatBusy` 상태
- `loadHeartbeatFile()`, `saveHeartbeatFile()`
- `startHeartbeat()`, `stopHeartbeat()`
- `runHeartbeatJob(job)`
- `fs.watch` 리로더

**export**: `startHeartbeat`, `stopHeartbeat`, `loadHeartbeatFile`, `saveHeartbeatFile`

**의존**: `orchestrator.js` (orchestrate), `telegram.js` (broadcast to Telegram), `settings`

---

### `server.js` 잔여 (~350줄)
```
남는 것: L1-39 imports, L40-77 dirs/migration, L263-329 settings, L408-513 CLI detection/quota,
         L1119-1405 Express routes + WebSocket, L1781-1800 boot
```
- imports + `.env` loader
- Config paths, directory ensure, migration
- Settings (load, save, migrate)
- CLI detection + quota functions
- Express app + routes (20+ endpoints)
- WebSocket server + broadcast
- `server.listen` + boot sequence

---

## 의존성 그래프

```
server.js (glue + routes)
  ├── src/db.js          (순수, 의존 없음)
  ├── src/prompt.js      (db, settings, heartbeat)
  ├── src/events.js      (broadcast 콜백)
  ├── src/agent.js       (db, prompt, events, broadcast)
  ├── src/orchestrator.js (agent, db, prompt, broadcast)
  ├── src/telegram.js    (orchestrator, broadcast, settings)
  └── src/heartbeat.js   (orchestrator, telegram, settings)
```

## 핵심 설계 결정: broadcast 주입 방식

현재 `broadcast()`는 전역 함수로 모든 곳에서 직접 호출됨.
모듈 분리 시 **3가지 옵션**:

| 방식                          | 장점                        | 단점                    |
| ----------------------------- | --------------------------- | ----------------------- |
| **A. 콜백 주입**              | 간단, 테스트 용이           | 매 함수에 파라미터 추가 |
| **B. EventEmitter 싱글톤**    | 깔끔한 분리                 | 새 추상화 레이어        |
| **C. 공유 모듈 `src/bus.js`** | 중간 지점, import만 하면 됨 | 순환 의존 주의          |

**추천: C (bus.js)** — `broadcast`, `addBroadcastListener`, `removeBroadcastListener`를 `src/bus.js`에 빼고 모든 모듈에서 import.

---

## 체크리스트

- [ ] `src/bus.js` — broadcast EventEmitter 분리
- [ ] `src/db.js` — DB 분리
- [ ] `src/prompt.js` — 프롬프트 생성 분리
- [ ] `src/events.js` — 이벤트 파서 분리
- [ ] `src/agent.js` — 에이전트 spawn 분리
- [ ] `src/orchestrator.js` — 오케스트레이션 분리
- [ ] `src/telegram.js` — 텔레그램 분리
- [ ] `src/heartbeat.js` — 하트비트 분리
- [ ] `server.js` 리팩토링 — glue + routes only
- [ ] 서버 부팅 테스트
- [ ] Telegram + Web UI 기능 테스트

## 실행 순서 (의존성 최소화)

1. `src/bus.js` (의존 없음)
2. `src/db.js` (의존 없음)
3. `src/events.js` (bus만 의존)
4. `src/prompt.js` (db 의존)
5. `src/agent.js` (db, prompt, events, bus)
6. `src/orchestrator.js` (agent, db, prompt, bus)
7. `src/telegram.js` (orchestrator, bus)
8. `src/heartbeat.js` (orchestrator, telegram)
9. `server.js` 정리 (모든 모듈 import + routes + boot)
