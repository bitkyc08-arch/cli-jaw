---
created: 2026-03-28
tags: [cli-jaw, ndjson, stream-events, parser]
aliases: [CLI Stream Event Reference, stream events, NDJSON parser]
---

# CLI Stream Event Reference (NDJSON + WS)

> 각 CLI의 NDJSON/ACP 이벤트를 `src/agent/events.ts`가 파싱하고, `broadcast()`가 public WebSocket 또는 internal-only path와 내부 listener로 fan-out 한다.
> 마지막 코드 대조: 2026-04-27 (`broadcast(...)`, `spawn.ts`, `events.ts`, `lifecycle-handler.ts`, `public/js/ws.ts`)

---

## 1. 전체 흐름

```text
CLI spawn / ACP session
  → raw stdout/stderr lines
  → src/agent/events.ts
      - logEventSummary()
      - extractFromEvent()
      - extractOutputChunk()
  → broadcast(type, data, audience)  // src/core/bus.ts
  → public/js/ws.ts
      - status / queue / process block / final render
  → orchestrator listeners
      - collect.ts
      - telegram/discord forwarders
```

`broadcast()`는 `audience === 'public'`일 때 WebSocket으로 push하고, audience와 무관하게 internal listener callback을 수행한다. Employee/internal 이벤트는 public WebSocket을 건너뛰지만 collector/forwarder listener에는 전달된다.

---

## 2. 실제 Broadcast / WebSocket 이벤트 Surface

`src/core/bus.ts`의 `broadcast(type, data, audience = 'public')`가 단일 fan-out 지점이다. WebSocket payload는 항상 `{ type, ...data, ts: Date.now() }` 형태이며, `audience === 'public'`일 때만 WS로 전송된다. 내부 listener(`addBroadcastListener`)는 public/internal 여부와 무관하게 호출된다.

### 현재 코드에서 실제 emit되는 이벤트 (22종)

| Type | 대표 payload | 발행 위치 / 용도 |
| --- | --- | --- |
| `agent_status` | `{ running? \| status?, agentId, cli?, isEmployee?, phase?, phaseLabel? }` | `spawn.ts`, `lifecycle-handler.ts`, `orchestrator/distribute.ts`; agent 실행/종료/worker phase |
| `agent_tool` | `{ agentId, icon, label, toolType?, detail?, stepRef?, status?, isEmployee? }` | `agent/events.ts`, `spawn.ts`; CLI/ACP tool, thinking, search, subagent step |
| `agent_output` | `{ agentId, cli, text, isEmployee? }` | `spawn.ts`; live preview chunk |
| `agent_done` | `{ text, toolLog?, error?, origin?, isEmployee? }` | `lifecycle-handler.ts`, `spawn.ts`, `server.ts`; authoritative final/error |
| `agent_retry` | `{ cli, delay, reason, isEmployee? }` | 429 retry 안내 |
| `agent_fallback` | `{ from, to, reason, isEmployee? }` | fallback CLI 전환 안내 |
| `agent_smoke` | `{ cli, confidence, reason, agentId, isEmployee? }` | smoke response auto-continue 안내 |
| `queue_update` | `{ pending }` | `spawn.ts`; message queue 길이 |
| `new_message` | `{ role, content, source, cli?, fromQueue? }` | `spawn.ts`, `orchestrator/gateway.ts`, `routes/orchestrate.ts`; remote/queued user bubble |
| `orchestrate_done` | `{ text, error?, origin?, chatId?, target?, requestId? }` | `orchestrator/pipeline.ts`, `gateway.ts`, `spawn.ts`; orchestration/queued result |
| `orc_state` | `{ state, title?, scope?, taskAnchor?, resolvedSelection? }` | `orchestrator/state-machine.ts`; PABCD 상태 |
| `clear` | `{}` | `server.ts`, `core/main-session.ts`; UI clear |
| `session_reset` | `{ cli, model }` | `core/main-session.ts`; history-preserving session reset |
| `agent_added` | `Employee` | `routes/employees.ts`; 직원 생성 |
| `agent_updated` | `Employee \| {}` | `routes/employees.ts`, `core/employees.ts`; 직원 수정/reset |
| `agent_deleted` | `{ id }` | `routes/employees.ts`; 직원 삭제 |
| `memory_status` | `buildMemorySyncPayload(reason)` | `routes/jaw-memory.ts`; memory sidebar refresh |
| `heartbeat_pending` | `{ pending, deferredPending, reason?, policy?, jobId?, jobName? }` | `memory/heartbeat.ts`; heartbeat busy/defer queue |
| `system_notice` | `{ code, text }` | `core/compact.ts`, `lifecycle-handler.ts`; compact/session refresh notice |
| `worker_stalled` | `{ agentId, employeeName, isEmployee: true }` | `orchestrator/distribute.ts`; worker stall |
| `worker_disconnected` | `{ agentId, exitCode, isEmployee: true }` | `orchestrator/distribute.ts`; worker disconnect |
| `worker_timeout` | `{ agentId, employeeName, isEmployee: true }` | `orchestrator/distribute.ts`; worker timeout |

### `public/js/ws.ts`가 직접 처리하는 emit 이벤트

현재 Web UI는 실제 emit 이벤트 중 `agent_status`, `queue_update`, `agent_tool`, `agent_output`, `agent_retry`, `agent_fallback`, `agent_smoke`, `agent_done`, `orchestrate_done`, `clear`, `session_reset`, `agent_added`, `agent_updated`, `agent_deleted`, `heartbeat_pending`, `orc_state`, `memory_status`, `new_message`를 처리한다.

### 백엔드 emit은 있으나 Web UI 직접 분기는 없는 이벤트

| Type | 현재 처리 경로 |
| --- | --- |
| `worker_stalled` / `worker_disconnected` / `worker_timeout` | bus/internal listener에는 전달되지만 `public/js/ws.ts` 직접 분기는 없다 |
| `system_notice` | WS public emit은 되지만 `public/js/ws.ts` 직접 분기는 없다 |

### Web UI에 legacy 분기만 남은 타입

`worklog_created`, `round_start`, `round_done`은 `public/js/ws.ts` 분기가 남아 있지만 현재 `server.ts`/`src/**/*.ts`의 실제 `broadcast(...)` emit surface에는 없다.

---

## 3. Claude Code CLI

호출 플래그:

```text
--output-format stream-json --verbose --include-partial-messages
```

### top-level 타입

| type | 설명 | jaw 처리 |
| --- | --- | --- |
| `system` | init/status/subtype metadata | model/tools/version 저장, compacting 상태 감지 |
| `stream_event` | Anthropic streaming wrapper | 아래 세부 규칙 적용 |
| `assistant` | 완성된 assistant message | stream_event가 없을 때 text/tool fallback |
| `user` | tool_result 포함 user message | tool_use 완료 상태(done/error) 반영 |
| `result` | 최종 결과 | cost/turns/duration/session/usage 저장 |
| `rate_limit_event` | quota/retry 신호 | warning tool label broadcast |

### `stream_event` 내부 처리

| inner type | 세부 | 처리 |
| --- | --- | --- |
| `content_block_start` | `tool_use` | 일반 tool은 `🔧 {name}`, `Agent` tool은 `🤖 subagent`; 둘 다 `stepRef=claude:tooluse:{id}` |
| `content_block_start` | `thinking` | placeholder는 내보내지 않고 버퍼 시작 |
| `content_block_delta` | `thinking_delta` | `claudeThinkingBuf`에 축적 |
| `content_block_delta` | `input_json_delta` | `claudeInputJsonBuf`에 축적 |
| `content_block_delta` | `signature_delta` | 의도적으로 무시 |
| `message_delta` | `usage.output_tokens` | output token 갱신 |
| `content_block_stop` | — | thinking/input_json flush |

### Claude buffer flush

```text
thinking_delta → claudeThinkingBuf 축적
input_json_delta → claudeInputJsonBuf 축적
content_block_stop →
  1. thinking을 💭 step으로 broadcast
  2. input_json을 JSON.parse
  3. summarizeToolInput()로 마지막 tool label detail 보강
stream close →
  flushClaudeBuffers()로 잔여 버퍼 정리
```

### 추가 상태

- `system.status === 'compacting'` 또는 subtype compacting:
  `🗜️ compacting...`
- compact boundary:
  `✅ conversation compacted`
- `user.message.content[].tool_result`:
  동일 `stepRef`의 tool을 `done` 또는 `error`로 갱신
- `system.subtype === 'task_started'`:
  `🤖 subagent: {description}` + `toolType=subagent` + `status=running` + `stepRef=claude:task:{task_id}`.
- `system.subtype === 'task_notification'`:
  같은 `claude:task:{task_id}` step을 `✅ done` 또는 `❌ error`로 갱신하고 summary/output_file/usage detail을 붙인다.

---

## 4. Codex CLI (`--json`)

| event.type | 조건 | jaw 처리 |
| --- | --- | --- |
| `thread.started` | — | session/thread id 추출 |
| `turn.started` | — | trace에 turn boundary 기록 |
| `item.started` | `command_execution` | `🔧 {command}` + `status=running`, `stepRef=codex:item:{id}` |
| `item.completed` | `command_execution` | `⚡` 또는 `❌` + detail + exit code |
| `item.completed` | `reasoning` | `💭` thinking |
| `item.completed` | `web_search` + `search` | `🔍 {query}` |
| `item.completed` | `web_search` + `open_page` | `🌐 {hostname}` |
| `item.started` | `collab_tool_call` + `spawn_agent`/`wait` | `🤖 {tool}...`, `toolType=subagent`, `status=running`, `stepRef=codex:collab:{id}`, `ctx.hasActiveSubAgent=true` |
| `item.completed` | `collab_tool_call` + `spawn_agent`/`wait` | `✅ {tool} done`, same `stepRef`, receiver/agent state detail, `ctx.hasActiveSubAgent=false` |
| `item.completed` | `agent_message` | final text 누적 |
| `turn.completed` | `usage` | input/output/cached_input token 저장 |

### 참고

- command 실행 step은 running과 done/error를 같은 `stepRef`로 연결한다.
- `ctx.hasActiveSubAgent`가 true이면 `spawn.ts`가 lifecycle activity를 `heartbeat`로 터치해 subagent wait 동안 stall 판정을 피한다.
- `agent_output` 라이브 chunk는 `extractOutputChunk()`가 `agent_message`에서 뽑는다.

---

## 5. Gemini CLI (`-o stream-json`)

| event.type | jaw 처리 |
| --- | --- |
| `init` | model/session id 저장 |
| `tool_use` | `🔧 {tool_name}` + command/detail + `stepRef=gemini:tool...` |
| `tool_result` | `✅` 또는 `❌` + same `stepRef` |
| `message` (assistant) | fullText 누적 |
| `result` | duration/tool_calls/token stats 저장 |

Gemini는 `tool_id`가 있으면 `gemini:toolid:{tool_id}`, 없으면 `gemini:tool:{tool_name}`를 쓴다.

---

## 6. Copilot ACP

ACP 자체는 NDJSON이 아니라 `session/update` 이벤트를 사용한다. 현재 Copilot ACP task/subagent 관측 wire shape은 `tool_call`의 `rawInput.agent_type === 'task'`이며, 완료는 같은 `toolCallId`의 `tool_call_update`로 온다.

| update type | jaw 처리 |
| --- | --- |
| `agent_thought_chunk` | `💭` thinking |
| `tool_call` | 일반 tool은 kind 기반 `📖/✏️/⚡/🔍/🌐` 또는 `🔧`, `stepRef=acp:callid:{toolCallId}` |
| `tool_call` + `rawInput.agent_type='task'` | `🤖 subagent: {title/description/name}`, `toolType=subagent`, `status=running`, same `stepRef` |
| `tool_call_update` | status map: `pending→⏳/pending`, `running|in_progress→🔧/running`, `completed→✅/done`, `failed→❌/error`, unknown→`❔/{raw status}` |
| `agent_message_chunk` | fullText 누적 |
| `plan` | `📝 planning...` |
| `session_cancelled` / `cancelled` | `⏹️` cancellation tool entry |
| `request_permission` | `🔐 permission: ...`, `status=pending` audit entry |

권한 요청은 parser가 아니라 `src/cli/acp-client.ts`에서 자동 승인한다.

`extractFromAcpSubagent()`는 `subagent.started/completed/failed/selected/deselected` 보조 매핑을 유지하지만, 21.x Copilot task 표시의 주요 경로는 `tool_call(rawInput.agent_type='task')` + `tool_call_update`다.

---

## 7. OpenCode CLI (`--format json`)

| event.type | jaw 처리 |
| --- | --- |
| `tool_use` + `part.tool === 'task'` | `🤖/✅/❌ subagent[{subagent_type}]: {description}`, `toolType=subagent`, `stepRef=opencode:call:{callID}` |
| `tool_use` | 일반 tool은 `🔧/✅/❌ {tool}` |
| `tool_result` | 일반 tool은 `✅ {tool}`; task `callID`가 ctx에 등록된 경우 기존 subagent step을 갱신 |
| `text` | fullText 누적 |
| `step_start` | trace/model metadata 기록 |
| `step_finish` | sessionId/tokens/cost/time 누적 |

OpenCode는 여러 step에 걸친 token/cost를 누적합으로 저장한다. `step_finish` 시 pending running tools를 done/error로 finalize하고, task tool output은 `<task_result>...</task_result>`를 정리해 detail에 넣는다.

---

## 8. `agent_output`와 최종 응답

### 라이브 출력

- `src/agent/spawn.ts`는 일부 CLI 경로에서 `broadcast('agent_output', { text })`를 실제로 보낸다.
- `public/js/ws.ts`는 이를 받아 `appendAgentText()`로 preview를 갱신한다.

### authoritative final

- 최종 텍스트는 `src/agent/lifecycle-handler.ts`의 `broadcast('agent_done', { text, toolLog, origin })`가 기준이다.
- Web UI도 주석대로 live stream은 preview-only이고, `agent_done`을 authoritative 결과로 취급한다.

### collect.ts와의 drift

`src/orchestrator/collect.ts`에는 아직 "no broadcast emits agent_output" 주석이 남아 있지만, 현재 `spawn.ts`는 실제로 `agent_output`을 emit 한다. 즉 이 부분은 코드 주석이 stale이고, 동작 기준은 `spawn.ts` + `ws.ts`다.

---

## 9. ProcessBlock 연동

`public/js/ws.ts`가 `agent_tool`을 받으면 `showProcessStep()`을 호출한다.

### step type 매핑

| `agent_tool.toolType` | UI step type |
| --- | --- |
| `thinking` | `thinking` |
| `search` | `search` |
| `subagent` | `subagent` |
| 그 외 | `tool` |

### ProcessStep 주요 필드

| Field | 용도 |
| --- | --- |
| `icon` | `💭`, `🔧`, `✅`, `❌`, `🔍`, `🌐` 등 |
| `rawIcon` | 원본 emoji 보존용. 없으면 frontend가 `icon`을 rawIcon으로 저장 |
| `label` | 짧은 요약 라벨 |
| `detail` | 자세한 입력/출력 preview |
| `toolType` | `thinking`, `search`, `subagent`, `tool` semantic 분류 |
| `stepRef` | running ↔ done/error 매칭 키 |
| `status` | `running`, `done`, `error`, 그리고 ACP에서 온 `pending`, `cancelled`, `unknown` 같은 raw 상태도 통과 가능 |

---

## 10. `stepRef`

동일 tool step의 상태 전이를 안정적으로 연결하는 키.

| CLI | 형식 | 예시 |
| --- | --- | --- |
| Claude | `claude:tooluse:{id}` | `claude:tooluse:toolu_...` |
| Claude task lifecycle | `claude:task:{task_id}` | `claude:task:task-1` |
| Codex | `codex:item:{item.id}` | `codex:item:abc123` |
| Codex collab subagent | `codex:collab:{item.id}` | `codex:collab:collab-1` |
| Gemini | `gemini:toolid:{tool_id}` 또는 `gemini:tool:{name}` | `gemini:toolid:42` |
| OpenCode | `opencode:tool:{tool}` / `opencode:call:{callID}` | `opencode:call:task:0` |
| ACP tool/task | `acp:callid:{toolCallId}` | `acp:callid:toolu_1` |
| ACP subagent helper | `acp:subagent:{toolCallId}` / `acp:subagent:selection:{agentName}` | `acp:subagent:tool-1` |

running step과 done/error step이 같은 `stepRef`를 쓰면, parser/runtime이 기존 running 항목을 찾아 교체한다. ACP branch dedupe도 `icon:label:stepRef:status`를 쓰므로 같은 이름의 반복 tool/subagent 호출을 보존한다.

---

## 11. `summarizeToolInput()`

도구 입력을 한 줄 detail로 축약하는 함수.

| Tool | 요약 방식 |
| --- | --- |
| `bash`, `Bash` | `input.command` |
| `read`, `Read` | `input.file_path` |
| `edit`, `Edit` | `{file_path}:{old_str}->{new_str}` preview |
| `write`, `Write` | `input.file_path` |
| `grep`, `Grep` | `{pattern} in {path}` |
| `glob`, `Glob` | `input.pattern` |
| `WebSearch` | `input.query` |
| `WebFetch` | `input.url` |
| 기타 | JSON stringify preview |

Claude의 `input_json_delta` flush, Gemini tool detail, ACP tool detail 생성이 이 함수를 공유한다.
