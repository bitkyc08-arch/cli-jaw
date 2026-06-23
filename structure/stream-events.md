---
created: 2026-03-28
tags: [cli-jaw, sse, websocket, ndjson, stream-events, parser]
aliases: [CLI Stream Event Reference, stream events, SSE event channel, NDJSON parser]
---

# CLI Stream Event Reference (SSE + Legacy WS + Provider Streams)

> 각 CLI의 NDJSON/ACP/stream-json 이벤트를 `src/agent/events/`가 파싱하고, AGY plain-text output은 `spawn.ts`가 직접 처리한다. X-01 이후 current server의 public Web delivery는 `src/core/event-bus.ts` + `GET /api/events` SSE channel이 담당한다. WebSocket은 current server broadcast path가 아니라 `/api/events`가 한 번도 열리지 않는 pre-X-01 server용 client/TUI fallback이다.
> 마지막 코드 대조: 2026-06-11 (`src/core/bus.ts`, `src/core/event-bus.ts`, `src/routes/events.ts`, `src/agent/spawn.ts`, `src/agent/events/*`, `src/agent/agy-runtime.ts`, `src/agent/claude-e-runtime.ts`, `src/agent/lifecycle-handler.ts`, `public/js/event-channel.ts`, `public/js/ws.ts`)

---

## 1. 전체 흐름

```text
CLI spawn / ACP session
  → raw stdout/stderr lines
  → AGY: spawn.ts plain-text branch
  → Other standard CLIs: src/agent/events/*
      - logEventSummary()
      - extractFromEvent()
      - extractOutputChunk()
  → broadcast(type, data, audience)  // src/core/bus.ts
      - public SSE topic/event publish through src/core/event-bus.ts
      - internal listeners regardless of audience
  → public/js/event-channel.ts
      - EventSource singleton
      - Last-Event-ID / ?lastEventId replay
      - replay_gap notice
      - legacy WebSocket fallback only when /api/events is unavailable
  → public/js/ws.ts
      - shared UI event handlers
      - legacy WebSocket compatibility only for pre-X-01 servers
  → bin/commands/tui/channel.ts
      - SSE-first terminal chat transport
      - outbound REST to /api/message and /api/stop
      - legacy WebSocket fallback only for pre-X-01 servers
  → orchestrator listeners
      - collect.ts
      - telegram/discord forwarders
```

`broadcast()`는 `audience === 'public'`일 때 SSE event bus에 publish한다. X-01 이후 서버의 legacy WebSocket public broadcast path는 제거되었다. audience와 무관하게 internal listener callback은 수행된다. Employee/internal 이벤트는 public SSE를 건너뛰지만 collector/forwarder listener에는 전달된다.

`GET /api/events`는 data-only SSE wire format이다. 서버는 `event:` field를 쓰지 않고, `data:` JSON payload 안에 `{ topic, event, ...payload }`를 넣는다. 클라이언트는 단일 `onmessage` handler로 모든 topic/event를 받아 dispatch한다.

SSE behavior:

| Surface | Contract |
| --- | --- |
| Endpoint | `GET /api/events` |
| Replay cursor | `Last-Event-ID` header or `?lastEventId=` query |
| Ring buffer | `src/core/event-bus.ts` `RING_SIZE = 1000` |
| Listener cap | `MAX_SSE_LISTENERS = 256`, overflow returns `503 { error: "SSE_CAPACITY" }` |
| Heartbeat | comment ping every 15 seconds |
| Replay gap | `data: {"topic":"system","event":"replay_gap"}` |
| Client fallback | `public/js/event-channel.ts` fires unavailable once when SSE errors before first open, then `public/js/ws.ts` uses legacy WebSocket fallback |
| Transient drop UX | `public/js/ws.ts` waits `CHANNEL_DOWN_TOAST_GRACE_MS = 8000` before showing a disconnected system message; fast SSE reconnects stay silent |

### Manager worker SSE bridge

`jaw dashboard serve` does not make the React manager browser subscribe directly to every worker's EventSource. The manager server starts `src/manager/worker-events.ts`, which listens for worker lifecycle changes and uses `src/manager/worker-sse-client.ts` to subscribe to each live worker's `http://127.0.0.1:{port}/api/events` stream. Worker SSE updates feed a debounced latest-message cache used by manager/Jaw CEO surfaces; the React manager still consumes manager HTTP polling endpoints such as `/api/manager/events` and `/api/dashboard/instances`.

---

## 2. 실제 Broadcast / SSE / WebSocket 이벤트 Surface

`src/core/bus.ts`의 `broadcast(type, data, audience = 'public')`가 단일 fan-out 지점이다. Current server의 public Web delivery는 SSE-only이며, `src/routes/events.ts`의 `formatSse()`가 `{ ...entry.data, topic, event }`를 `data:` JSON payload로 쓴다. 내부 listener(`addBroadcastListener`)는 public/internal 여부와 무관하게 호출된다. Legacy WebSocket payload shape `{ type, ...payload }`는 client/TUI fallback이 pre-X-01 server에 붙을 때만 의미가 있다.

### 현재 코드에서 실제 emit되는 이벤트 (47종)

| Type | 대표 payload | 발행 위치 / 용도 |
| --- | --- | --- |
| `agent_status` | `{ running? \| status?, agentId, cli?, isEmployee?, phase?, phaseLabel? }` | `spawn.ts`, `lifecycle-handler.ts`, `orchestrator/distribute.ts`; agent 실행/종료/worker phase |
| `agent_tool` | `{ agentId, icon, label, toolType?, detail?, stepRef?, status?, isEmployee? }` | `agent/events.ts`, `spawn.ts`; CLI/ACP tool, thinking, search, subagent step |
| `agent_output` | `{ agentId, cli, text, isEmployee? }` | `spawn.ts`; live preview chunk, including AGY plain stdout |
| `agent_done` | `{ text, toolLog?, error?, origin?, isEmployee? }` | `lifecycle-handler.ts`, `spawn.ts`, `server.ts`; authoritative final/error |
| `agent:claude-e:runtime_started` | `{ runId, seq, version? }` | `claude-e-runtime.ts`; native helper run started |
| `agent:claude-e:spawned` | `{ runId, pid }` | `claude-e-runtime.ts`; underlying Claude process spawned |
| `agent:claude-e:session` | `{ runId, sessionId, transcriptPath? }` | `claude-e-runtime.ts`; helper discovered Claude session/transcript |
| `agent:claude-e:prompt_injected` | `{ runId }` | `claude-e-runtime.ts`; prompt was written into the PTY session |
| `agent:claude-e:stop` | `{ runId, transcriptPath? }` | `claude-e-runtime.ts`; stop signal observed |
| `agent:claude-e:stop_failure` | `{ runId, error? }` | `claude-e-runtime.ts`; stop/cleanup failed |
| `agent:claude-e:interrupted` | `{ runId, sessionId?, resumable? }` | `claude-e-runtime.ts`; graceful SIGINT interrupt and resume metadata |
| `agent:claude-e:cleanup` | `{ runId, event, escalated? }` | `claude-e-runtime.ts`; cleanup start/done lifecycle |
| `agent:claude-e:error` | `{ runId, message?, exitCode? }` | `claude-e-runtime.ts`; helper/runtime error |
| `agent_retry` | `{ cli, delay, reason, attempt?, maxRetries?, isEmployee? }` | 429/transient retry 안내. Main runs use exponential backoff up to 3 attempts; employee transient retries use a shorter backoff up to 2 attempts. |
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
| `heartbeat_pending` | `{ pending, deferredPending, agentBusyPending, reason?, policy?, jobId?, jobName? }` | `memory/heartbeat.ts`; heartbeat busy/defer queue. `reason` may be `busy`, `pabcd_active`, or `agent_busy` |
| `system_notice` | `{ code, text }` | `core/compact.ts`, `lifecycle-handler.ts`; compact/session refresh notice |
| `alert_escalation` | `{ message?, reason?, ... }` | `agent/alert-escalation.ts`; repeated failure / capacity fallback escalation |
| `settings_change` | `{ ... }` | settings/project/workspace refresh signal |
| `steer_started` | `{ prompt, origin? }` | `handlers-workflows.ts`, `routes/orchestrate.ts`; accepted steer prompt |
| `session_switched` | `{ sessionId }` | session switch broadcast |
| `session_created` | `{ session }` | session create broadcast |
| `session_list` | `{ sessions }` | session list refresh |
| `goal_done` | `{ ... }` | durable goal completion |
| `goal_done_rejected` | `{ ... }` | completion evidence gate rejection |
| `goal_cancel` | `{ ... }` | durable goal cancellation |
| `goal_pause_detected` | `{ ... }` | pause 2-tap gate detection |
| `goal_continuation` | `{ ... }` | goal continuation kick |
| `goal_continuation_failed` | `{ ... }` | goal continuation failure |
| `goal_continuation_limit` | `{ ... }` | bounded continuation limit |
| `schedule_wakeup` | `{ ... }` | ScheduleWakeup accepted |
| `schedule_wakeup_failed` | `{ ... }` | ScheduleWakeup failed |
| `worker_stalled` | `{ agentId, employeeName, isEmployee: true }` | `orchestrator/distribute.ts`; worker stall; progress snapshot `attention.kind=stalled` |
| `worker_disconnected` | `{ agentId, exitCode, isEmployee: true }` | `orchestrator/distribute.ts`; worker disconnect; progress snapshot `attention.kind=disconnected` |
| `worker_timeout` | `{ agentId, employeeName, isEmployee: true }` | `orchestrator/distribute.ts`; worker timeout; progress snapshot `attention.kind=timeout` |
| `worker_run_started` | `{ runId, agentId, employeeName, status, statusCategory, outputBytes, seq, taskPreview }` | `orchestrator/worker-run-store.ts`; durable run started safe event |
| `worker_run_progress` | `{ runId, agentId, employeeName, status, statusCategory, outputBytes, seq, tools, toolCount }` | `orchestrator/worker-run-store.ts`; sanitized tool progress snapshot; no raw output |
| `worker_run_attention` | `{ runId, agentId, employeeName, status, statusCategory, outputBytes, seq, attention }` | `orchestrator/worker-run-store.ts`; safe attention metadata |
| `worker_run_done` / `worker_run_failed` / `worker_run_cancelled` | `{ runId, agentId, employeeName, status, statusCategory, outputBytes, seq, completedAt, safeSummary? }` | `orchestrator/worker-run-store.ts`; completion event; raw output path/content excluded |

Worker run events, delayed replay notices, and batch dispatch summaries are safe metadata surfaces. They may carry bounded previews and recovery commands, but they do not embed raw employee stdout; raw worker output remains an explicit `/api/orchestrate/worker-runs/:runId/output` / `cli-jaw worker read <runId>` read path.

`bgtask_update` frames stay on topic `bgtask` and expose `running[]` plus `changed`; both entries keep native bgtask `status` and add shared `statusCategory`. Worker runs and bgtasks do not share storage, but Manager can compare their status buckets without reimplementing per-surface mappings.

### Web client handling

현재 Web UI는 `public/js/event-channel.ts`를 통해 SSE payload를 받고, topic/event subscription을 `public/js/ws.ts`의 기존 handler path로 연결한다. legacy WebSocket fallback도 같은 handler set을 사용하므로 UI event 처리 코드는 transport와 분리되어 있다.

### 백엔드 emit은 있으나 Web UI 직접 분기는 없는 이벤트

| Type | 현재 처리 경로 |
| --- | --- |
| `worker_stalled` / `worker_disconnected` / `worker_timeout` | `public/js/ws.ts`에서 disconnected/timeout/stalled handler로 처리하고, manager server는 worker-SSE bridge/cache로 별도 추적한다. 현재/이전 worker progress API는 UI hydration용 safe `attention` metadata도 제공한다 |
| `worker_run_*` | safe SSE/replay와 `/api/orchestrate/worker-runs*` read API용 backend contract다. Manager Worker Runs 패널은 기존 frontend worker progress EventSource bridge로 이 이벤트를 refresh invalidation으로 소비하고, raw output은 명시 클릭 시 `/output` route로만 읽는다 |
| `system_notice` | SSE public emit은 되지만 `public/js/ws.ts` 직접 분기는 없다 |
| `agent:claude-e:*` | native helper lifecycle/status telemetry. 현재 Web UI 직접 분기는 없고, trace/internal listener와 외부 observer용이다 |

### Web UI에 legacy 분기만 남은 타입

`worklog_created`, `round_start`, `round_done`은 `public/js/ws.ts` 분기가 남아 있지만 현재 `server.ts`/`src/**/*.ts`의 실제 `broadcast(...)` emit surface에는 없다.

---

## 3. Claude Code CLI

호출 플래그:

```text
--print/-p --output-format stream-json --verbose --include-partial-messages
```

Plaintext `thinking_delta`는 headless `--print`/`-p` stream에서 partial message streaming이 켜져야 온다. `claude-e` helper는 interactive PTY wrapper라 이 옵션 조합을 wrapper 뒤 Claude TUI에 강제하지 않고, transcript completed message의 plaintext thinking 또는 signature-only encrypted marker를 처리한다.

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

### Claude E / Claude Interactive (`claude-e`)

`claude-e`는 Claude CLI를 PTY로 띄우고, transcript tail과 hook output을 JSONL로 다시 내보내는 experimental runtime이다. Compatibility `claude-exec` and legacy `jaw-claude-i` / `claude-i` helper names remain fallback binaries. Public registry key is `claude-e`; runtime telemetry namespace is `agent:claude-e:*`. Some persisted helper/session internals still use the historical `claude-i` bucket name. `src/agent/spawn.ts`는 helper의 `jaw_runtime` 이벤트를 discriminator 전에 처리하고, 일반 Claude `system`/`assistant`/`result` event는 Claude-like parser 경로를 공유한다.

호출 플래그:

```text
run --jsonl --output-format stream-json --timeout-ms 600000 [--resume <sessionId>] -- <claude args...>
```

| helper/event | jaw 처리 |
| --- | --- |
| `jaw_runtime.runtime_started` | `agent:claude-e:runtime_started` broadcast |
| `jaw_runtime.claude_spawned` | underlying Claude pid telemetry |
| `jaw_runtime.session_started` | `ctx.sessionId` 저장 + `agent:claude-e:session` broadcast |
| `jaw_runtime.interrupted` | graceful SIGINT resume metadata 저장 |
| `assistant` | transcript에서 온 완성 assistant message를 text block 단위로 `fullText`에 누적하고 `agent_output` single chunk로 preview |
| `result` | cost/turns/duration/session/usage를 Claude path와 동일하게 저장 |

Session bucket은 `claude-i`로 분리되어 standard `claude` session ID와 섞이지 않는다. Helper는 interactive Claude CLI를 래핑하므로 `jaw doctor`가 selected runtime(`claude-e` preferred)과 underlying `claude` 설치/버전을 둘 다 확인한다.

Thinking visibility:

- Claude CLI `-p --verbose --output-format stream-json --include-partial-messages`에서는 `thinking_delta`가 plaintext로 나온다.
- interactive 모드에는 `--include-partial-messages`가 적용되지 않으므로, helper는 transcript의 final assistant message만 볼 수 있다.
- transcript `assistant.message.content[].type === "thinking"`에 plaintext `thinking`이 있으면 `💭` thinking step으로 표시한다.
- plaintext가 비어 있고 `signature`만 있으면 빈 `thinking...` placeholder가 아니라 `🔒 encrypted thinking`으로 표시한다.

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

## 4b. Codex AppServer (`codex-app`)

`codex-app` 경로는 `codex app-server --listen stdio://`의 JSON-RPC notification을 `agent_tool`/`agent_output` 경로로 맞춘다.

Reasoning config:

| 위치 | 값 |
| --- | --- |
| `thread/start.config.model_reasoning_summary` | `detailed` |
| `thread/start.config.hide_agent_reasoning` | `false` |
| `thread/start.config.show_raw_agent_reasoning` | `true` |
| `turn/start.summary` | `detailed` |
| `turn/start.effort` | 현재 UI/설정 effort |

| method | 조건 | jaw 처리 |
| --- | --- | --- |
| `item/started` | `reasoning` + 빈 `summary/content` | placeholder 없이 무시 |
| `item/started` | `reasoning` + 기존 `summary/content` 있음 | 초기 reasoning을 `💭` thinking buffer에 축적 |
| `item/reasoning/textDelta` | raw reasoning delta | `💭` thinking buffer에 축적 |
| `item/reasoning/summaryTextDelta` | summary delta | `💭` thinking buffer에 축적 |
| `item/reasoning/summaryPartAdded` | summary index 증가 | thinking buffer에 줄바꿈 삽입 |
| `item/completed` | `reasoning` + 기존 buffer 있음 | thinking buffer flush |
| `item/completed` | `reasoning` + buffer 없음 | completed item의 string/object-shaped `content[]` 우선, 없으면 `summary[]` fallback 표시 |
| `item/agentMessage/delta` | final answer delta | live output text에 축적 |
| `thread/tokenUsage/updated` | token usage | input/output/cached token 저장 |

raw `textDelta`는 app-server/모델 조합이 제공할 때만 온다. 확인된 `gpt-5.4-mini` app-server smoke에서는 raw `textDelta` 대신 `summaryTextDelta` detailed stream이 왔다.

---

## 5. Antigravity / AGY CLI (`-p`)

AGY is not an NDJSON runtime in cli-jaw. It uses direct print mode and the current model selected inside native AGY UI:

```text
agy -p <prompt> --print-timeout 10m --log-file <tmp> [--dangerously-skip-permissions] [--add-dir <dir>...]
agy --conversation <sessionId> -p <prompt> --print-timeout 10m --log-file <tmp> [...]
```

`spawn.ts` routes AGY stdout as plain text: each chunk is appended to `ctx.fullText`, scanned for `--conversation=<id>` resume hints, recorded as a trace `plain_text` event, emitted through `agent_output`, and skipped from `events.ts` JSON parsing. Because `agy -p` normally prints only the answer, close handling also scans the per-run log for `Created conversation <id>` / `conversation=<id>` before removing that log. `spawn-env.ts` sets `NO_COLOR=1` by default so chunks remain preview-safe.

Timeout handling is stdout-based and anchored to the transcript final-planner signal. If AGY prints only `Error: timed out waiting for response`, or prints progress text followed by that timeout before a fresh final `PLANNER_RESPONSE` row is observed, `agy-runtime.ts` classifies the run as effective exit code `124`, records a trace `runtime_error`, clears final text, and lets lifecycle/fallback/smoke handling see the timeout as a runtime failure. Once a fresh final planner row is seen, its `content` is the authoritative final text; this strips native resume replay such as previous-turn answers before persistence. A trailing timeout can be stripped only after that final-planner anchor has been seen, preserving completed answers without saving progress-only resume turns as completion.

## 6. Cursor CLI (`--output-format stream-json`)

호출 플래그:

```text
cursor-agent -p --trust --output-format stream-json --model <resolvedModelId> [--force]
cursor-agent --resume <chatId> -p --trust --output-format stream-json --model <resolvedModelId> [...]
```

Cursor CLI는 separate effort flag가 없으므로 `src/agent/cursor-runtime.ts`가 model+effort를 full model id로 먼저 해석한다. `system` 이벤트에서 `session_id`와 model metadata를 저장하고, `assistant` message/content text는 snapshot/delta 중복을 줄여 `pendingOutputChunk`로 flush한다.

| event.type | jaw 처리 |
| --- | --- |
| `system` | session id, model, raw cursor metadata 저장 |
| `assistant` | text delta/snapshot을 `fullText`와 `agent_output` chunk로 누적 |
| `tool_call` | `🔧 {name}` running/done/error step, `stepRef=cursor:tool:{call_id}` |
| `result` | session id, token usage, duration, cost, finish reason 저장; rejected/error result는 tool error로 기록 |

---

## 7. Gemini CLI (`-o stream-json`)

| event.type | jaw 처리 |
| --- | --- |
| `init` | model/session id 저장 |
| `tool_use` | `🔧 {tool_name}` + command/detail + `stepRef=gemini:tool...` |
| `tool_result` | `✅` 또는 `❌` + same `stepRef` |
| `message` (assistant) | fullText 누적 |
| `result` | duration/tool_calls/token stats 저장 |

Gemini는 `tool_id`가 있으면 `gemini:toolid:{tool_id}`, 없으면 `gemini:tool:{tool_name}`를 쓴다.

---

## 8. Grok CLI (`--output-format streaming-json`)

호출 플래그:

```text
-p <prompt> --output-format streaming-json --no-alt-screen
```

`grok-build`는 현재 `--effort` / `--reasoning-effort`를 서버가 거부하므로 cli-jaw는 Grok 경로에 effort 또는 system-prompt override 플래그를 넘기지 않는다. 프로젝트 지침은 Grok CLI가 cwd의 instruction files를 읽는 쪽에 맡기고, 대화 히스토리는 `-p` prompt 문자열에 합쳐 넣는다.

| event.type | jaw 처리 |
| --- | --- |
| `thought` | 기본적으로 final text에 넣지 않는다. `showReasoning`이 켜진 경우에만 buffer 후 `end`에서 💭 thinking step으로 flush |
| `text` | `data`/`text` delta를 `fullText`와 `agent_output` live chunk에 그대로 누적 |
| `end` | `sessionId`, `stopReason`, `requestId`를 세션/metadata에 저장 |
| `error` | final text에 섞지 않고 `❌` tool step으로 기록, `stepRef=grok:error:{requestId or run}` |

Grok `streaming-json`은 실제 tool을 실행해도 일부 버전에서 live stdout에 `tool_use`/`tool_result`를 내보내지 않는다. cli-jaw는 `end.sessionId`가 있는 정상 종료 후 `grok trace --local --json <sessionId>`를 실행하고 trace archive의 `chat_history.jsonl`에서 `tool_calls`/`tool_result`를 backfill해 최종 `agent_done.toolLog`에 반영한다. 이 보강은 direct `grok`와 `ai-e`의 Grok provider 모두에 적용된다.

Grok CLI 런타임과 `browser web-ai --vendor grok`는 별도 표면이다. 전자는 local CLI process/streaming-json, 후자는 `grok.com` 브라우저 자동화다.

## 9. Copilot ACP

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

## 10. OpenCode CLI (`--format json`)

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

## 11. `agent_output`와 최종 응답

### 라이브 출력 bullet 정렬 (`appendAssistantTextSegment`)

Codex/Claude/Gemini/Cursor/OpenCode는 `src/agent/events/helpers.ts`의 `appendAssistantTextSegment()`로 live chunk를 누적한다.

| 규칙 | 결과 |
| --- | --- |
| 첫 assistant segment (tool 없음) | raw text |
| 첫 assistant segment (tool 이미 있음) | `- {text}` |
| 이후 segment | `\n- {text}` (공백/구두점 경계 예외는 helpers 참고) |

Plain-text runtime은 raw stdout(`fullText`)과 display-normalized preview(`liveOutputText`)를 분리한다. 표시용 preview는 `normalizeAssistantDisplayText()`를 거쳐 JSON-style escaped newline (`\n`, `\r\n`, `\r`)이 UI에 literal text로 새지 않게 한다.

| CLI | raw capture | formatted `agent_output` |
| --- | --- | --- |
| `agy` | stdout → `fullText` | normalized stdout delta → `liveOutputText` + `agent_output` |
| `pi` | RPC text delta → `fullText` | normalized RPC text delta → `liveOutputText` + `agent_output` |
| `kiro-code` | stdout → `fullText` (kiro-runtime) | normalized `assistant_delta` → `liveOutputText` (no `-` inject; Kiro has native `- Completed` / numbered lines) |
| `grok` | NDJSON handler → `fullText` | raw delta concat → `pendingOutputChunk` (paragraph bullets deferred) |
| `copilot` (ACP) | ACP chunks → `fullText` | `appendAssistantTextSegment` + `agent_output` broadcast |

Web UI는 ProcessBlock(아이콘 - 라벨) 아래 markdown list bullet(`- ...`)로 흘러나오는 assistant preview를 기대한다.
Final `agent_done` body도 `resolveSpawnOutputText()`에서 normalized display candidates를 raw escaped candidates보다 우선해 streaming 중 고친 줄바꿈이 완료 시점에 되돌아가지 않게 한다.

### 라이브 출력

- `src/agent/spawn.ts`는 일부 CLI 경로에서 `broadcast('agent_output', { text })`를 실제로 보낸다.
- `public/js/ws.ts`는 이를 받아 `appendAgentText()`로 preview를 갱신한다.

### authoritative final

- 최종 텍스트는 `src/agent/lifecycle-handler.ts`의 `broadcast('agent_done', { text, toolLog, origin })`가 기준이다.
- Web UI도 주석대로 live stream은 preview-only이고, `agent_done`을 authoritative 결과로 취급한다.

### collect.ts와의 drift

`src/orchestrator/collect.ts`에는 아직 "no broadcast emits agent_output" 주석이 남아 있지만, 현재 `spawn.ts`는 실제로 `agent_output`을 emit 한다. 즉 이 부분은 코드 주석이 stale이고, 동작 기준은 `spawn.ts` + `ws.ts`다.

---

## 12. ProcessBlock 연동

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

## 13. `stepRef`

동일 tool step의 상태 전이를 안정적으로 연결하는 키.

| CLI | 형식 | 예시 |
| --- | --- | --- |
| Claude | `claude:tooluse:{id}` | `claude:tooluse:toolu_...` |
| Claude task lifecycle | `claude:task:{task_id}` | `claude:task:task-1` |
| Codex | `codex:item:{item.id}` | `codex:item:abc123` |
| Codex collab subagent | `codex:collab:{item.id}` | `codex:collab:collab-1` |
| Cursor | `cursor:tool:{call_id}` | `cursor:tool:call-1` |
| Gemini | `gemini:toolid:{tool_id}` 또는 `gemini:tool:{name}` | `gemini:toolid:42` |
| OpenCode | `opencode:tool:{tool}` / `opencode:call:{callID}` | `opencode:call:task:0` |
| ACP tool/task | `acp:callid:{toolCallId}` | `acp:callid:toolu_1` |
| ACP subagent helper | `acp:subagent:{toolCallId}` / `acp:subagent:selection:{agentName}` | `acp:subagent:tool-1` |

running step과 done/error step이 같은 `stepRef`를 쓰면, parser/runtime이 기존 running 항목을 찾아 교체한다. ACP branch dedupe도 `icon:label:stepRef:status`를 쓰므로 같은 이름의 반복 tool/subagent 호출을 보존한다.

---

## 14. `summarizeToolInput()`

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
