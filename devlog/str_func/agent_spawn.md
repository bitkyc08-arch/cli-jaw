# Agent Spawn — agent.js · events.js · orchestrator.js · acp-client.js

> CLI spawn + ACP 분기 + 스트림 + 큐 + 메모리 flush + 멀티에이전트 오케스트레이션

---

## agent.js — CLI Spawn & Queue + ACP 분기 (611L)

| Function                                   | 역할                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `killActiveAgent(reason)`                  | SIGTERM → SIGKILL 종료                               |
| `steerAgent(newPrompt, source)`            | kill → 대기 → 새 프롬프트로 restart                  |
| `enqueueMessage(prompt, source)`           | 큐에 메시지 추가                                     |
| `buildHistoryBlock(currentPrompt, ...)`    | DB에서 최신 trace 기반 히스토리 8000자               |
| `withHistoryPrompt(prompt, historyBlock)`  | 히스토리 + 프롬프트 조합                             |
| `buildArgs(cli, model, effort, prompt, …)` | 신규 세션용 CLI args                                 |
| `buildResumeArgs(…)`                       | resume용 args                                        |
| `spawnAgent(prompt, opts)`                 | **핵심** — spawn/ACP/stream/DB/broadcast + origin    |
| `triggerMemoryFlush()`                     | threshold개 메시지 요약 → 메모리 파일 (줄글 1-3문장) |
| `flushCycleCount`                          | flush 사이클 카운터 (x2 주입용)                      |

### spawnAgent 흐름 (ACP 분기 포함)

```text
실행 중 체크 → cli/model/effort 결정 → origin 설정 (opts.origin || 'web')
→ cli === 'copilot' ?
    [YES] AcpClient 경로:
      → new AcpClient(model, workingDir, permissions)
      → acp.initialize() → acp.createSession(workDir) or loadSession()
      → acp.on('session/update') → extractFromAcpUpdate → broadcast + activityPing()
      → **ctx reset** (fullText='', toolLog=[], seenToolKeys.clear()) ← loadSession 히스토리 리플레이 방지
      → acp.prompt(text) → { promise, activityPing } → child = acp.proc
    [NO] 기존 spawn 경로:
      → resume or new args
      → buildHistoryBlock(prompt) ← 신규 세션만
      → child spawn → CLI별 stdin 주입
→ stdout NDJSON 파싱 + logEventSummary → ctx.traceLog 누적
→ 종료: insertMessageWithTrace / session 저장 / processQueue
→ broadcast('agent_done', { text, toolLog, origin })
```

### origin 전달

- `spawnAgent(prompt, { origin: 'telegram' })` — 텔레그램 기원
- `spawnAgent(prompt, { origin: 'web' })` — 웹/CLI 기원 (기본)
- `broadcast('agent_done', { ..., origin })` — 포워딩 판단에 사용

### 메모리 flush 상세

- `triggerMemoryFlush()`: `forceNew` spawn → 메인 세션 분리
- threshold개 메시지만 요약 (줄글 1-3문장)
- `flushCycleCount`로 x2 주입 시점 추적

---

## acp-client.js — Copilot ACP JSON-RPC 클라이언트 (311L) `[NEW]`

| Class / Method               | 역할                                              |
| ---------------------------- | ------------------------------------------------- |
| `AcpClient({ model, workDir, permissions })` | spawn copilot --acp + NDJSON over stdio |
| `spawn()`                    | 프로세스 생성 + readline NDJSON 파싱              |
| `kill()`                     | SIGTERM 종료                                      |
| `request(method, params, timeout)` | JSON-RPC request (응답 대기, Promise, 30s 기본) |
| `requestWithActivityTimeout(method, params, idleMs, maxMs)` | **활동 기반 타임아웃** — idle+절대 이중 타이머, `{ promise, activityPing }` 반환 |
| `notify(method, params)`     | JSON-RPC notification (응답 없음)                 |
| `_handleLine(line)`          | NDJSON 라인 파싱 + response/notification 분기     |
| `_handleAgentRequest(msg)`   | 에이전트→클라이언트 요청 자동 처리 (permission 자동 승인) |
| `initialize()`               | ACP 핸드셰이크 (protocolVersion + clientInfo)     |
| `createSession(workDir)`     | `session/new` → sessionId 반환 + 자동 저장        |
| `prompt(text, sessionId)`    | `session/prompt` → activityTimeout (idle 120s, max 20min) |
| `loadSession(sessionId)`     | `session/load` → 이전 세션 이어하기               |
| `cancel(sessionId)`          | `session/cancel` notification                     |
| `shutdown()`                 | `shutdown` → proc kill                            |
| `hasCapability(name)`        | 에이전트 capability 지원 여부 확인                |

### ACP 이벤트 플로우

```text
Client (cli-claw)               Agent (copilot --acp)
  ├─→ initialize ──────────────→  capabilities 교환
  ├─→ session/new ─────────────→  세션 생성
  ├─→ session/prompt ──────────→  질의
  │←── session/update           │  agent_thought_chunk / tool_call /
  │                             │  tool_call_update / agent_message_chunk
  │←── session/prompt result ──│  완료 (stopReason)
  ├─→ session/load ────────────→  이어하기 (선택적)
```

### 권한 모드

| cli-claw 설정          | Copilot 플래그/config.json                        |
| ---------------------- | --------------------------------------------- |
| `permissions: 'auto'`  | `--allow-all-tools`                           |
| `permissions: 'yolo'`  | `--yolo` (== `--allow-all-tools --allow-all-paths --allow-all-urls`) |

---

## events.js — NDJSON Event Parsing + Dedupe + ACP (318L)

| Function                                        | 역할                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `extractSessionId(cli, event)`                  | CLI별 세션 ID 추출                                |
| `extractFromEvent(cli, event, ctx, agentLabel)` | 이벤트 → UI 데이터 변환                           |
| `extractToolLabels(cli, event, ctx)`            | 툴 사용 라벨 추출 (**dedupe key 기반**)           |
| `makeClaudeToolKey(event, label)`               | Claude dedupe 키 생성 (claude:idx/msg/type:icon:label) |
| `pushToolLabel(labels, label, cli, event, ctx)` | dedupe 검사 후 라벨 추가                          |
| `extractToolLabel(cli, event)`                  | Backward-compat: 첨 라벨 반환 (or null)          |
| `extractFromAcpUpdate(params)`                  | **ACP `session/update`** → cli-claw broadcast 변환 |
| `logEventSummary(agentLabel, cli, event, ctx)`  | 이벤트별 한 줄 로그 + traceLog 누적               |
| `pushTrace(ctx, line)`                          | ctx.traceLog에 라인 추가                          |
| `logLine(line, ctx)`                            | console.log + pushTrace 동시                      |
| `toSingleLine(text)` / `toIndentedPreview()`    | 포맷팅 헬퍼                                       |

### 이벤트 dedupe 로직

```text
1. extractToolLabels(cli, event, ctx) 호출
2. Claude stream_event 수신 → ctx.hasClaudeStreamEvents = true 세팅
3. makeClaudeToolKey() → claude:idx/msg/type:icon:label 형태 키 생성
4. ctx.seenToolKeys Set에서 중복 체크
5. 이미 수신된 키면 스킵, 새 키면 추가
6. hasClaudeStreamEvents === true일 때 assistant tool block 전체 스킵
```

### CLI별 이벤트 매핑

| CLI      | 이벤트 타입                              |
| -------- | ---------------------------------------- |
| claude   | `system` / `assistant` / `result` + `stream_event` |
| codex    | `thread.started` / `item.completed`      |
| gemini   | `init` / `message` / `result`            |
| opencode | `text` / `step_finish`                   |
| **copilot** | **ACP `session/update`** (별도 파서)  |

### ACP session/update 파싱

```js
extractFromAcpUpdate(params):
  agent_thought_chunk → { tool: { icon: '💭', label: ... } }
  tool_call           → { tool: { icon: '🔧', label: name } }
  tool_call_update    → { tool: { icon: '✅', label: name } }
  agent_message_chunk → { text: extractText(content) }
  plan                → { tool: { icon: '📝', label: 'planning...' } }
```

---

## orchestrator.js — Orchestration v2 + Triage + 순차실행 + origin 전달 (584L)

| Function                     | 역할                                           |
| ---------------------------- | ---------------------------------------------- |
| `isContinueIntent(text)`     | "이어서 해줘" 패턴 감지                        |
| `needsOrchestration(text)`   | **Triage Tier 1** — 2+ signal이면 pipeline     |
| `parseSubtasks(text)`        | 텍스트 → JSON subtask 파싱                     |
| `parseDirectAnswer(text)`    | **Triage Tier 2** — direct_answer JSON 파싱    |
| `stripSubtaskJSON(text)`     | subtask JSON 제거                              |
| `initAgentPhases(subtasks)`  | 에이전트별 phase profile 초기화                |
| `advancePhase(ap, passed)`   | phase 전진/완료                                |
| `phasePlan(prompt, worklog)` | planning agent 호출 (트리아지 판단 포함)       |
| `distributeByPhase(...)`     | **순차 실행** — for-of 루프, 이전 결과 주입    |
| `phaseReview(...)`           | per-agent verdict 판정                         |
| `orchestrate(prompt, meta)`  | **메인** — triage → plan → distribute → review |
| `orchestrateContinue(meta)`  | 이전 worklog 이어서 실행                       |

### origin 전달

```js
orchestrate(prompt, { origin: 'telegram' })  // meta.origin → spawnAgent에 전달
orchestrateContinue({ origin: 'telegram' })  // 이어하기에도 origin 전달
```

### 오케스트레이션 플로우 (v2)

```text
orchestrate(prompt, meta)
  ├─ Tier 1: needsOrchestration(prompt) false → direct agent (origin 전달)
  ├─ employees === 0 → direct agent (origin 전달)
  └─ pipeline:
      1. phasePlan → direct_answer? → 즉시 응답 (Tier 2)
      2. initAgentPhases → phase profile
      3. round loop (max 3):
         distributeByPhase (순차, 이전 결과 주입, origin 전달)
         → phaseReview → verdict → phase advance
```

---

## prompt.js — System Prompt & Skills (502L)

| Function                                | 역할                                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| `loadActiveSkills()`                    | 활성 스킬 로드                                                        |
| `loadSkillRegistry()`                   | 스킬 레지스트리 로드                                                  |
| `getMergedSkills()`                     | 번들 + 사용자 스킬 병합                                               |
| `initPromptFiles()`                     | A-1, A-2, HEARTBEAT 프롬프트 초기화                                   |
| `getSystemPrompt()`                     | A-1 + A-2 + MEMORY.md + skills + employees + heartbeat + vision-click |
| `loadRecentMemories()`                  | flush 메모리 최신순 로드 (10000자 제한)                               |
| `getSubAgentPrompt(emp)`                | 실행자용 경량 프롬프트                                                |
| `getSubAgentPromptV2(emp, role, phase)` | **v2** — dev 스킬 + role 스킬 + phase gate + 순차실행 인식            |
| `regenerateB()`                         | B 프롬프트 + CODEX AGENTS.md 재생성                                   |
