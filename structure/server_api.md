---
created: 2026-03-28
tags: [cli-jaw, server, api, express]
aliases: [CLI-JAW Server API, server.ts reference, server_api]
---

> 📚 [INDEX](INDEX.md) · [체크리스트 ↗](AGENTS.md) · [커맨드 ↗](commands.md) · **서버 API**

# server.ts — Glue + Route Registration (593L)

> Express/SSE bootstrap + localhost/LAN opt-in 보안 가드 + `src/routes/*` registrar + mounted sub-router 등록.
> 현재 라이브 surface는 총 204개 route handler이며, 이 중 `/`를 제외한 API 엔드포인트는 203개다.
> mutation route(`POST`/`PUT`/`DELETE`)는 모두 `requireAuth`를 거친다. 단, `requireAuth()`는 loopback 요청을 토큰 없이 통과시키고, `lanAllowed()`가 true일 때 private IP도 LAN bypass로 통과시킨다.
> `GET /api/auth/token`은 Bearer bootstrap 전용이며 `Sec-Fetch-Site`가 `same-origin` 또는 `none`이 아닐 때 `403`을 반환한다.

---

## Route Module Architecture

| Module | Lines | Routes | 역할 |
| --- | ---: | ---: | --- |
| `server.ts` | 593L | mount glue | Helmet/CORS/Host/rate-limit/SSE bootstrap + static middleware + route/sub-router registration |
| `src/routes/static.ts` | 30L | 2 | root HTML + `/media/:filename` upload media serve |
| `src/routes/system.ts` | 57L | 4 | health/session/runtime/auth-token |
| `src/routes/messages.ts` | 107L | 4 | message list/count/search/latest |
| `src/routes/command.ts` | 108L | 3 | slash command execution, command palette, normal message submit |
| `src/routes/instance.ts` | 53L | 3 | instance lock GET/POST/DELETE |
| `src/routes/chat-sessions.ts` | 30L | 3 | session list/create/switch |
| `src/routes/task.ts` | 59L | 2 | agent-native task list/action API |
| `src/routes/events.ts` | 82L | 1 | `/api/events` data-only SSE event channel |
| `src/routes/settings.ts` | 430L | 23 | settings/prompt/project pick/git summary/heartbeat-md/MCP/CLI registry/quota/copilot/Pi profile registration |
| `src/routes/memory.ts` | 191L | 13 | memory runtime + KV memory + memory files |
| `src/routes/browser.ts` | 488L | 43 | browser primitive/tab/debug/doctor/cleanup routes + adaptive fetch + web-ai render/send/poll/watch/sessions/capabilities/code/context routes |
| `src/routes/jaw-memory.ts` | 352L | 12 | jaw memory search/read/save/context/list/init/reflect/flush/soul/soul-activate/bootstrap |
| `src/routes/orchestrate.ts` | 841L | 14 | reset/state/workers/worker-progress/snapshot/queue cancel/hold/queue steer async accept/dispatch/batch dispatch/worker result/state PUT |
| `src/routes/goal.ts` | 177L | 3 | durable goal state get/history/set-update-complete-cancel-pause-resume-clear-reset |
| `src/routes/goal-run.ts` | 83L | 3 | bounded goal-run state/preflight/start-pause-resume-stop |
| `src/routes/messaging.ts` | 259L | 6 | upload/file-open/voice/telegram/channel/discord send |
| `src/routes/employees.ts` | 123L | 5 | employee CRUD + reset |
| `src/routes/skills.ts` | 89L | 5 | skills list/read/enable/disable/reset |
| `src/routes/avatar.ts` | 146L | 4 | avatar summary + agent/user image upload/delete/read |
| `src/routes/traces.ts` | 80L | 3 | public trace summary/event read routes |
| `src/routes/link-preview.ts` | 319L | 2 | Rich link preview metadata fetch + guarded image proxy |
| `src/routes/heartbeat.ts` | 47L | 2 | heartbeat GET + validated PUT |
| `src/routes/jaw-ceo.ts` | 321L | 20 | Jaw CEO coordinator: state/message/query/docs-edit/settings/events/pending/watch/audit/voice/confirmations |
| `src/routes/runtime-context.ts` | 46L | 4 | runtime context entry CRUD (ephemeral prompt injection), mounted at `/api/runtime-context` |
| `src/routes/security-audit.ts` | 18L | 2 | security audit log entries + verify, mounted at `/api/security-audit` |
| `src/routes/i18n.ts` | 35L | 2 | language list + locale bundle |
| `src/routes/quota.ts` | 528L | — | `settings.ts`가 호출하는 quota/auth/status reader helper |
| `src/routes/quota-kiro-reverse.ts` | 239L | — | Kiro/CodeWhisperer reverse-engineered usage-limits reader (`fetchKiroUsage`) |
| `src/routes/quota-agy-reverse.ts` | 158L | — | Antigravity quota snapshot reader (`fetchAgyUsage`) |
| `src/routes/quota-cursor-dashboard.ts` | 203L | — | Cursor dashboard session/usage reader (`fetchCursorUsage`) |
| `src/routes/types.ts` | 3L | — | shared `AuthMiddleware` type |

### Dashboard Board/Schedule (P3, mounted in server.ts)

| Module | Routes | 역할 |
| --- | ---: | --- |
| `src/manager/board/routes.ts` | 99L / 5 | board tasks CRUD + from-message |
| `src/manager/schedule/routes.ts` | 112L / 5 | scheduled work CRUD + dispatch |

### 등록 순서 (`server.ts`)

```text
static → employees → heartbeat → skills → jaw-memory → orchestrate
→ goal → task → events(SSE) → instance → chat-sessions → messages
→ system → agent-control → command → goal-run → memory → settings
→ messaging → avatar → traces → link-preview → jaw-ceo → runtime-context
→ security-audit → dashboard board/schedule → browser → i18n
```

라우트 모듈은 `server.ts:298-396` 부근에서 등록된다.

---

## Base Route Surface (`server.ts`)

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/` | `public/dist/index.html`이 있으면 Vite build를 서빙, 없으면 static fallback |
| `GET` | `/api/health` | `{ ok, version, uptime }` |
| `GET` | `/api/session` | 현재 main session row 반환 |
| `GET` | `/api/messages` | `includeTrace=1|true|yes`면 trace 포함 메시지 조회. `?limit=N`(1–5000)이면 최근 N개만 ascending 반환; 생략 시 전체 history |
| `GET` | `/api/messages/search` | 메시지 본문 검색 결과 반환. `?q=`, `?days=N`(1-365), `?recent=N`(1-5000), `?context=N`(0-5), `?limit=N`(1-50) |
| `GET` | `/api/messages/latest` | 가장 최근 메시지 스냅샷 반환 |
| `GET` | `/api/runtime` | uptime, activeAgent, queuePending |
| `GET` | `/api/auth/token` | same-origin/CLI용 Bearer token bootstrap |
| `POST` | `/api/command` | slash command 실행 |
| `GET` | `/api/commands` | 인터페이스별 command palette 데이터 |
| `POST` | `/api/message` | 일반 프롬프트 제출 |
| `POST` | `/api/stop` | 현재 실행 중 agent 모두 종료 |
| `POST` | `/api/clear` | UI-only clear broadcast, DB 메시지는 유지 |
| `POST` | `/api/session/reset` | 메시지 삭제 + session reset |
| `GET` | `/media/:filename` | 미디어 파일 서빙 |
| `GET` | `/api/instance/lock` | 인스턴스 잠금 상태 조회 |
| `POST` | `/api/instance/lock` | 인스턴스 잠금 (stopAll 보호) |
| `DELETE` | `/api/instance/lock` | 인스턴스 잠금 해제 |
| `GET` | `/api/chat-sessions` | 채팅 세션 목록 |
| `POST` | `/api/chat-sessions` | 새 채팅 세션 생성 |
| `POST` | `/api/chat-sessions/:id/switch` | 활성 세션 전환 |

---

## REST API

| Category | Endpoints |
| --- | --- |
| Core/Auth | `GET /api/health` `GET /api/session` `GET /api/messages` `GET /api/messages/count` `GET /api/messages/search` `GET /api/messages/latest` `GET /api/runtime` `GET /api/auth/token` `GET /media/:filename` `POST /api/message` `POST /api/stop` `POST /api/clear` `POST /api/session/reset` |
| Commands | `POST /api/command` `GET /api/commands?interface=` |
| Events | `GET /api/events` |
| Chat Sessions | `GET /api/chat-sessions` `POST /api/chat-sessions` `POST /api/chat-sessions/:id/switch` |
| Instance Lock | `GET /api/instance/lock` `POST /api/instance/lock` `DELETE /api/instance/lock` |
| Settings/Prompt | `GET/PUT /api/settings` `POST /api/project/pick` `GET /api/project/git-summary` `GET /api/codex-context` `GET/PUT /api/prompt` `GET /api/prompt-templates` `PUT /api/prompt-templates/:id` `GET/PUT /api/heartbeat-md` |
| MCP/CLI/Quota | `GET/PUT /api/mcp` `POST /api/mcp/sync` `POST /api/mcp/install` `POST /api/mcp/reset` `GET /api/mcp/registry` `GET /api/cli-registry` `GET /api/cli-status` `GET /api/quota` `POST /api/copilot/refresh` `POST /api/pi/profiles/register` `GET /api/pi/models` |
| Runtime Context | `GET /api/runtime-context` `POST /api/runtime-context` `DELETE /api/runtime-context/:id` `DELETE /api/runtime-context` |
| Security Audit | `GET /api/security-audit/entries` `GET /api/security-audit/verify` |
| Heartbeat | `GET/PUT /api/heartbeat` |
| Browser | `POST /api/browser/start` `POST /api/browser/stop` `GET /api/browser/status` `GET /api/browser/doctor` `POST /api/browser/cleanup-runtimes` `GET /api/browser/snapshot` `POST /api/browser/screenshot` `POST /api/browser/act` `POST /api/browser/vision-click` `POST /api/browser/navigate` `POST /api/browser/reload` `POST /api/browser/resize` `GET /api/browser/tabs` `GET /api/browser/active-tab` `POST /api/browser/tab-switch` `POST /api/browser/tab-new` `POST /api/browser/tab-close` `POST /api/browser/tab-cleanup` `POST /api/browser/evaluate` `GET /api/browser/text` `GET /api/browser/dom` `GET /api/browser/console` `GET /api/browser/network` `POST /api/browser/fetch` `POST /api/browser/wait-for-selector` `POST /api/browser/wait-for-text` `POST /api/browser/web-ai/render` `POST /api/browser/web-ai/context-dry-run` `POST /api/browser/web-ai/context-render` `GET /api/browser/web-ai/status` `POST /api/browser/web-ai/send` `GET /api/browser/web-ai/poll` `GET /api/browser/web-ai/watch` `GET /api/browser/web-ai/watchers` `GET /api/browser/web-ai/sessions` `POST /api/browser/web-ai/sessions/prune` `GET /api/browser/web-ai/notifications` `GET /api/browser/web-ai/capabilities` `POST /api/browser/web-ai/query` `POST /api/browser/web-ai/code` `POST /api/browser/web-ai/code-extract` `POST /api/browser/web-ai/stop` `GET /api/browser/web-ai/diagnose` |
| Orchestrate | `POST /api/orchestrate/reset` `GET /api/orchestrate/state` `GET /api/orchestrate/workers` `GET /api/orchestrate/worker-progress` `GET /api/orchestrate/worker-progress/:agentId` `GET /api/orchestrate/snapshot` `DELETE /api/orchestrate/queue/:id` `POST /api/orchestrate/queue/:id/hold` `DELETE /api/orchestrate/queue/:id/hold` `POST /api/orchestrate/queue/:id/steer` `POST /api/orchestrate/dispatch` `POST /api/orchestrate/dispatch/batch` `GET /api/orchestrate/worker/:agentId/result` `PUT /api/orchestrate/state` |
| Goal | `GET /api/goal` `GET /api/goal/history` `POST /api/goal` |
| Goal Run | `GET /api/goal-run` `GET /api/goal-run/preflight` `POST /api/goal-run` |
| Task | `GET /api/task` `POST /api/task` |
| Employees | `GET /api/employees` `POST /api/employees` `PUT /api/employees/:id` `DELETE /api/employees/:id` `POST /api/employees/reset` `POST /api/employees/sessions/reset` |
| Skills | `GET /api/skills` `GET /api/skills/:id` `POST /api/skills/enable` `POST /api/skills/disable` `POST /api/skills/reset` |
| Memory Runtime / KV / Files | `GET /api/memory/status` `POST /api/memory/reindex` `POST /api/memory/bootstrap` `GET /api/memory/files` `GET /api/memory` `POST /api/memory` `DELETE /api/memory/:key` `GET /api/memory-files` `GET /api/memory-file` `GET /api/memory-files/:filename` `DELETE /api/memory-file` `DELETE /api/memory-files/:filename` `PUT /api/memory-files/settings` |
| Jaw Memory | `GET /api/jaw-memory/search` `GET /api/jaw-memory/read` `POST /api/jaw-memory/save` `GET /api/jaw-memory/context` `GET /api/jaw-memory/list` `POST /api/jaw-memory/init` `POST /api/jaw-memory/reflect` `POST /api/jaw-memory/flush` `GET /api/jaw-memory/soul` `POST /api/jaw-memory/soul/activate` `POST /api/jaw-memory/soul` `POST /api/soul/bootstrap` |
| Jaw CEO | `GET /api/jaw-ceo/state` `POST /api/jaw-ceo/message` `POST /api/jaw-ceo/query` `POST /api/jaw-ceo/docs/edit` `GET /api/jaw-ceo/settings` `PUT /api/jaw-ceo/settings` `POST /api/jaw-ceo/events/ingest` `POST /api/jaw-ceo/events/refresh` `GET /api/jaw-ceo/pending` `POST /api/jaw-ceo/pending/:completionKey/continue` `POST /api/jaw-ceo/pending/:completionKey/summarize` `POST /api/jaw-ceo/pending/:completionKey/ack` `POST /api/jaw-ceo/pending/:completionKey/dismiss` `POST /api/jaw-ceo/watch` `GET /api/jaw-ceo/audit` `POST /api/jaw-ceo/voice/connect` `POST /api/jaw-ceo/voice/:sessionId/close` `POST /api/jaw-ceo/confirmations` `POST /api/jaw-ceo/confirmations/:confirmationId/confirm` `POST /api/jaw-ceo/confirmations/:confirmationId/cancel` |
| Messaging | `POST /api/upload` `POST /api/file/open` `POST /api/voice` `POST /api/telegram/send` `POST /api/channel/send` `POST /api/discord/send` |
| Avatar | `GET /api/avatar` `POST /api/avatar/:target/upload` `DELETE /api/avatar/:target/image` `GET /api/avatar/:target/image` |
| Traces | `GET /api/traces/:runId` `GET /api/traces/:runId/events` `GET /api/traces/:runId/events/:seq` |
| Link Preview | `GET /api/link-preview?url=` `GET /api/link-preview/image?url=` |
| Dashboard Board | `GET /api/dashboard/board/tasks` `POST /api/dashboard/board/tasks` `PATCH /api/dashboard/board/tasks/:id` `DELETE /api/dashboard/board/tasks/:id` `POST /api/dashboard/board/tasks/from-message` |
| Dashboard Schedule | `GET /api/dashboard/schedule/work` `POST /api/dashboard/schedule/work` `PATCH /api/dashboard/schedule/work/:id` `DELETE /api/dashboard/schedule/work/:id` `POST /api/dashboard/schedule/work/:id/dispatch` |
| i18n | `GET /api/i18n/languages` `GET /api/i18n/:lang` |

> 실제 코드(`server.ts` + `src/routes/*.ts` + mounted runtime/security/Jaw CEO/dashboard sub-router)에서 추출한 총 204개 route handler 기준이다. 이 중 API 엔드포인트는 203개이고, 나머지 1개는 `/` 엔트리이다. Browser API 43개는 `src/routes/browser.ts`에서 등록된다. Jaw CEO 20개는 `src/routes/jaw-ceo.ts`에서 sub-router로 등록된다.

---

## Security / Guards

### 네트워크 가드

- 기본 서버 bind는 `127.0.0.1`이지만 `settings.network.bindHost`, `JAW_LAN_MODE=1`, reverse-proxy mode에 따라 `0.0.0.0` bind가 가능하다.
- `ALLOWED_HOSTS`/`ALLOWED_ORIGINS`는 loopback을 기본 허용하고, LAN mode/bypass가 켜졌을 때 private network origin/host를 허용한다.
- Legacy/client fallback WebSocket paths and manager-side note WebSocket surfaces must apply the same host/origin guard model; the current core public event path is SSE.

### 인증

- mutation route는 모두 `requireAuth`로 보호된다.
- 다만 로컬 동일 머신 사용성을 위해 loopback 요청은 Bearer 없이 허용된다. LAN bypass가 켜진 private IP 요청도 토큰 없이 통과할 수 있으므로 trusted network 전용이다.
- `/api/auth/token`은 cross-origin token theft 방지를 위해 `Sec-Fetch-Site`를 검사한다.

### 경로/파일 보안

| Surface | Guard |
| --- | --- |
| Jaw Memory | `assertMemoryRelPath()` + `normalizeAdvancedReadPath()` |
| Memory files | `assertMemoryRelPath()` / `assertFilename()` / `safeResolveUnder()` |
| Skills | `assertSkillId()` |
| Upload / avatar | `decodeFilenameSafe()` |
| Telegram / channel send | `assertSendFilePath()` |
| Avatar image serve | `safeResolveUnder(UPLOADS_DIR, basename(...))` |

### 기타

- Rate limit: in-memory, IP 기준 `120 req/min`.
- `helmet()` 사용, CSP/COEP는 현재 비활성.

---

## Selected Route Notes

### `/api/command`

- body `text`를 500자까지 자른 뒤 `parseCommand()`로 해석한다.
- locale은 body/query/Accept-Language/settings 순으로 정해지고 `Content-Language`가 세팅된다.
- command가 아니면 `400 { code: 'not_command' }`.

### `/api/goal` — action-based POST

- `POST /api/goal` body `{ action }` 분기: `set`, `refine-objective`, `update`, `done`, `cancel`, `pause`, `resume`, `clear`, `reset`.
- `set` may receive `goalMode: "plan"` and `planHint`; plan-mode stores a pending objective and rejects normal checkpoint updates until `refine-objective` replaces it with a concrete objective.
- `done` action은 `goalHasCompletionEvidence()` gate를 거치며, evidence 없으면 `409`를 반환한다. `force:true`로 override 가능.
- `resume` action은 이미 active이면 `{ alreadyActive:true }`를 반환하고, paused goal을 resume하면 `kickGoalContinuation()`을 즉시 트리거한다.

### `/api/orchestrate/dispatch`

- boss-scoped `x-jaw-boss-token`이 필수다. employee spawn 환경에서는 이 토큰이 제거되므로 직원이 다시 dispatch하는 흐름은 서버에서 `403`으로 막힌다.
- body는 정확히 하나의 target을 받는다: `{ agent, task }` 또는 `{ virtual, task, role?, cli?, model? }`.
- `virtual` target은 `src/core/employees.ts`의 `security`/`testing` 프리셋 또는 자유 role 문자열로 `SyntheticEmployeeRow`를 만들고, DB employee row로 저장하지 않는다.
- virtual dispatch에서 `cli`/`model`이 생략되면 현재 CLI와 `src/cli/registry.ts`의 registry default model을 사용한다.
- 현재 plan이 있으면 dispatch body 상단에 `## Approved Plan`으로 자동 주입된다.
- `POST /api/orchestrate/dispatch/batch`는 같은 boss token으로 여러 직원/virtual task를 병렬 dispatch한다. 각 entry는 `agent` 또는 `virtual` 중 하나를 가진다. 구버전 manager가 이 route 없이 HTML 404를 반환하면 `jaw dispatch --batch`는 JSON parse 예외 대신 stale/missing route 진단을 출력한다.

### `/api/jaw-ceo/*`

- `requireAuth` 보호 sub-router로 `/api/jaw-ceo` 아래 마운트.
- Core: state read, message send, query (dashboard/cli_readonly/web/github_read source), docs edit.
- Settings: OpenAI API key management for voice.
- Events: ingest manager events, refresh with port/cursor filter.
- Pending: list/continue/summarize/ack/dismiss completions.
- Watch/Audit: watch completion on port, audit log with kind/port filter.
- Voice: WebRTC connect via OpenAI Realtime API, session close.
- Confirmations: create/confirm/cancel action confirmations.

### `/api/quota`

- 응답 키: `pi`, `agy`, `ai-e`, `claude`, `claude-e`, `codex`, `codex-app`, `cursor`, `gemini`, `grok`, `opencode`, `copilot`, `kiro-code` (`CLI_KEYS` 순서).
- `pi`는 Settings의 Pi profile registration을 통해 endpoint/model/key를 검증하고, quota 자체는 auth/status-only로 표시한다.
- `agy`는 `src/routes/quota-agy-reverse.ts`의 `fetchAgyUsage()`를 통해 Antigravity quota snapshot을 읽는다.
- `antigravity-usage --json`이 `remainingPercentage`를 정밀 소수점 대신 `0`/`1`로만 반환하면 AGY window는 degraded fallback으로 `0 -> 100% used`, `1 -> 0% used`만 표시한다. upstream이 다시 정밀 퍼센트를 주면 기존 fractional path가 그대로 사용된다.
- `cursor`는 `src/routes/quota-cursor-dashboard.ts`의 `fetchCursorUsage()`를 통해 dashboard session/usage를 읽는다.
- `kiro-code`는 `src/routes/quota-kiro-reverse.ts`의 `fetchKiroUsage()`를 통해 CodeWhisperer `GetUsageLimits` API를 reverse-engineer 호출한다.

### `/api/project/git-summary`

- `GET /api/project/git-summary`는 Settings의 `projectDirs[0]`만 읽는 read-only header helper다.
- 응답은 legacy Web UI header의 compact git status 전용이다: branch/hash, tracked modified count, untracked count.
- project root가 없거나, home 밖 경로거나, git repository가 아니거나, git 호출이 실패하면 mutation 없이 `{ available:false, reason }` 형태로 조용히 숨길 수 있는 payload를 반환한다.
- status count는 `git status --porcelain=v1 -z --untracked-files=all` 기반이며 ignored entry는 표시하지 않는다.

### `/api/pi/*`

- `POST /api/pi/profiles/register` — body의 provider/endpoint/model/key/mode를 `normalizePiProfile()`로 정규화하고, isolated `PI_CODING_AGENT_DIR` 아래 `models.json` + `settings.json`을 만든 뒤 `pi --offline --list-models <profile>`로 등록 모델이 실제 Pi model list에 나타나는지 검증한다. 성공 시 `applySettings()`를 통해 `settings.pi`와 `perCli.pi.provider/model`을 함께 저장한다.
- `GET /api/pi/models?profile=<id>` — 저장된 Pi profile 설정으로 모델 목록을 재발견하고, `settings.pi.discoveredModels[profile]` 및 Settings UI dropdown 갱신에 사용할 배열을 반환한다.
- Pi 응답은 API key를 직접 반환하지 않고 `apiKeySet`, `apiKeyLast4`, `apiKeySource`만 노출한다.

### `/api/runtime-context`

- `GET` — 모든 entry를 반환하며 각 entry에 `expired` boolean을 추가한다.
- `POST` — body `{ text, label?, expiresAt? }`. `text`는 필수(max 2000자). 201 + 생성된 entry 반환.
- `DELETE /:id` — 단일 entry 삭제. 없으면 404.
- `DELETE /` — 전체 삭제. `{ cleared: <count> }` 반환.

### `/api/security-audit/*`

- `GET /entries` — audit log entries (limit param, max 500).
- `GET /verify` — integrity verification of audit chain.

---

## WebSocket Events

이 heading은 `structure/check-doc-drift.sh`의 anchor로 유지한다. X-01 이후 current server는 public browser events를 WebSocket으로 broadcast하지 않는다. 아래 catalog는 `src/core/bus.ts` → `src/core/event-bus.ts` → `GET /api/events`로 전달되는 public SSE event type surface다. WebSocket은 `public/js/ws.ts`와 `bin/commands/tui/channel.ts`가 `/api/events`를 한 번도 열 수 없는 pre-X-01 server에 붙을 때만 fallback path로 사용한다. Current Web UI는 reconnect 시 REST snapshot hydration으로 `agent_status`, `queue_update`, 비-IDLE `orc_state` 상태를 보강한다.

| Type | 설명 |
| --- | --- |
| `agent_status` | running/done/error/evaluating + agentId/phase |
| `agent_tool` | tool/thinking/search 진행 step |
| `agent_output` | 라이브 text chunk preview |
| `agent_done` | 최종 응답 + toolLog + origin |
| `agent_retry` / `agent_fallback` | retry/fallback 안내 |
| `alert_escalation` | repeated failure / capacity fallback escalation alert |
| `agent_smoke` | smoke auto-continue 안내 |
| `queue_update` | 대기열 길이 갱신 |
| `clear` / `session_reset` | UI clear / session reset broadcast |
| `new_message` | Telegram/Discord inbound message |
| `orc_state` | PABCD 상태 변경 + `taskAnchor`/`resolvedSelection`/`interview` 컨텍스트 |
| `orchestrate_done` / `orchestrate_warning` | orchestration 완료/실패 + 비차단 경고 |
| `steer_started` | `/steer` 또는 pending queue steer가 새 프롬프트를 accepted 상태로 전환 |
| `agent_added` / `agent_updated` / `agent_deleted` | employee CRUD 반영 |
| `agent:claude-e:runtime_started` / `agent:claude-e:spawned` / `agent:claude-e:session` / `agent:claude-e:prompt_injected` | Claude E native helper start/session/prompt lifecycle bridge |
| `agent:claude-e:stop` / `agent:claude-e:stop_failure` / `agent:claude-e:interrupted` / `agent:claude-e:cleanup` / `agent:claude-e:error` | Claude E native helper stop/error lifecycle bridge |
| `settings_change` | project/workspace settings 변경 신호 |
| `memory_status` | memory sidebar / runtime 상태 갱신 신호 |
| `system_notice` | compact refresh 같은 시스템 공지 |
| `heartbeat_pending` | pending heartbeat job 수 |
| `worker_stalled` / `worker_disconnected` / `worker_timeout` | distributed worker 상태 변화; 같은 상태가 `/api/orchestrate/worker-progress`의 safe `attention` metadata에도 반영됨 |
| `goal_done` / `goal_done_rejected` / `goal_cancel` / `goal_continuation` / `goal_continuation_failed` / `goal_continuation_limit` | durable goal / bounded continuation lifecycle |
| `goal_pause_detected` | goal pause 2-tap gate 감지 |
| `session_switched` / `session_created` / `session_list` | multi-session state update |
| `schedule_wakeup` / `schedule_wakeup_failed` | ScheduleWakeup continuation scheduling lifecycle |

---

## Manager Dashboard Server Surface

`jaw dashboard serve`가 띄우는 별도 manager 서버(`src/manager/server.ts`, 919L)는 core `server.ts` route count에 포함하지 않는다. Manager instance state는 `src/manager/instance-registry.ts`(120L)가 cached scan + diff event source로 제공한다. Manager React UI는 `/api/manager/events`, `/api/dashboard/instances`, `/i/:port/api/messages/latest` 계열 HTTP polling으로 상태를 읽고, manager server는 `src/manager/worker-events.ts` + `src/manager/worker-sse-client.ts`를 통해 각 worker instance의 `GET /api/events`를 server-side로 구독해 latest-message cache를 갱신한다. #233부터 worker의 `settings:settings_change`(cli/model/projectDirs 변경)는 `worker_settings_change`로 재발행되어 `GET /api/manager/events/stream`(SSE)으로 manager UI에 live 전달되고, UI(`useManagerEventStream`)는 해당 instance row를 즉시 재조회한다. Code mode의 goal/PABCD/background/worker monitors는 child Jaw instance가 아니라 manager-local `src/manager/routes/runtime-monitor.ts`를 통해 `/api/manager/runtime-status`, `/api/bgtask`, `/api/orchestrate/worker-progress` JSON API를 직접 읽는다. `/api/bgtask`의 `preset: "web-ai"` path는 native web-ai watcher가 진행하는 session id를 `session-status` probe로 관찰하고 `session-answer` extractor로 완료 결과를 전달한다. 이 bridge는 BrowserPanel tab state나 Code session transcript ownership으로 승격하지 않는다.

| Surface | Endpoints |
| --- | --- |
| Manager health/scan | `GET /api/dashboard/health` `GET /api/dashboard/instances` `GET /api/dashboard/instances/:port` `POST /api/dashboard/instances/:port/message` |
| Manager events/logs | `GET /api/manager/events` `GET /api/manager/events/stream` (SSE) `GET /api/manager/health-history/:port` `GET /api/manager/instance-logs/:port` |
| Runtime monitors | `GET /api/manager/runtime-status` `GET/POST /api/bgtask` `GET/DELETE /api/bgtask/:id` `GET /api/orchestrate/worker-progress` `GET /api/orchestrate/worker-progress/:agentId` |
| Registry | `GET /api/dashboard/registry` `PATCH /api/dashboard/registry` |
| Lifecycle | `POST /api/dashboard/lifecycle/:action` (start/stop/restart/perm/unperm) |
| Process control | `GET /api/dashboard/process-control` `POST /api/dashboard/process-control/adopt` `POST /api/dashboard/process-control/stop-managed` `POST /api/dashboard/process-control/force-release` |
| Desktop/Electron | `GET /api/dashboard/desktop-status` `GET/POST /api/dashboard/electron-metrics` |
| Notes | `GET /api/dashboard/notes/auth/status` `POST /api/dashboard/notes/ws-token` `GET /api/dashboard/notes/history/status` `POST /api/dashboard/notes/history/init` `GET /api/dashboard/notes/history` `GET /api/dashboard/notes/history/show` `GET /api/dashboard/notes/history/diff` `POST /api/dashboard/notes/history/flush` `GET /api/dashboard/notes/plugins` `GET /api/dashboard/notes/plugins/:id/asset/*` `GET /api/dashboard/notes/version` `POST /api/dashboard/notes/asset` `POST /api/dashboard/notes/asset/remote` `GET /api/dashboard/notes/asset` `GET /api/dashboard/notes/info` `GET /api/dashboard/notes/tree` `GET /api/dashboard/notes/templates` `GET /api/dashboard/notes/template` `GET /api/dashboard/notes/snippets` `GET /api/dashboard/notes/snippets/file` `PUT /api/dashboard/notes/snippets/toggle` `PUT /api/dashboard/notes/theme` `PUT /api/dashboard/notes/plugins/:id/toggle` `GET /api/dashboard/notes/search` `GET /api/dashboard/notes/index` `GET /api/dashboard/notes/capabilities` `GET/POST/PUT /api/dashboard/notes/file` `POST /api/dashboard/notes/folder` `POST /api/dashboard/notes/rename` `POST /api/dashboard/notes/trash` |
| Board | `GET/POST/PATCH/DELETE /api/dashboard/board/tasks` `POST /api/dashboard/board/tasks/from-message` |
| Schedule | `GET/POST/PATCH/DELETE /api/dashboard/schedule/work` `POST /api/dashboard/schedule/work/:id/dispatch` |
| Reminders | `GET /api/dashboard/reminders` `POST /api/dashboard/reminders` `POST /api/dashboard/reminders/from-message` `PATCH /api/dashboard/reminders/:id` |
| Connector | `POST /api/dashboard/connector/board` `PATCH /api/dashboard/connector/board/:id` `POST /api/dashboard/connector/reminders` `PATCH /api/dashboard/connector/reminders/:id` `POST /api/dashboard/connector/notes` `GET /api/dashboard/connector/audit` |
| Git diff/status/worktrees | `POST /api/dashboard/git/repo-candidates` `POST /api/dashboard/git/diff-summary` `POST /api/dashboard/git/file-diff` `POST /api/dashboard/git/status-map` `POST /api/dashboard/git/worktrees` `POST /api/dashboard/git/worktree-operation-preview` `POST /api/dashboard/git/worktree-operation` |
| Memory federation | `GET /api/dashboard/memory/instances` `GET /api/dashboard/memory/search` `GET /api/dashboard/memory/read` `GET /api/dashboard/memory/chat/search` |
| Memory embedding | `GET /api/dashboard/memory/embed-config` `POST /api/dashboard/memory/embed-config` `POST /api/dashboard/memory/reindex` `GET /api/dashboard/memory/embed-state` `GET /api/dashboard/memory/embed-estimate` `GET /api/dashboard/memory/reindex-stream` (SSE) |
| Jaw CEO (manager) | `/api/jaw-ceo/*` (same sub-router as core server) |
