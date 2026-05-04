---
created: 2026-03-28
tags: [cli-jaw, server, api, express]
aliases: [CLI-JAW Server API, server.ts reference, server_api]
---

> 📚 [INDEX](INDEX.md) · [체크리스트 ↗](AGENTS.md) · [커맨드 ↗](commands.md) · **서버 API**

# server.ts — Glue + Route Registration (726L)

> Express/WS bootstrap + localhost/LAN opt-in 보안 가드 + base route 13개 + `src/routes/*` 11개 registrar 등록.
> 현재 라이브 surface는 총 126개 route handler이며, 이 중 `/`를 제외한 API 엔드포인트는 125개다.
> mutation route(`POST`/`PUT`/`DELETE`)는 총 71개고 모두 `requireAuth`를 거친다. 단, `requireAuth()`는 loopback 요청을 토큰 없이 통과시키고, `lanAllowed()`가 true일 때 private IP도 LAN bypass로 통과시킨다.
> `GET /api/auth/token`은 Bearer bootstrap 전용이며 `Sec-Fetch-Site`가 `same-origin` 또는 `none`이 아닐 때 `403`을 반환한다.

---

## Route Module Architecture

| Module | Lines | Routes | 역할 |
| --- | ---: | ---: | --- |
| `server.ts` | 726L | 13 | Helmet/CORS/Host/rate-limit/WS/bootstrap + base routes + module registration |
| `src/routes/settings.ts` | 191L | 18 | settings/prompt/heartbeat-md/MCP/CLI registry/quota/copilot |
| `src/routes/memory.ts` | 185L | 13 | memory runtime + KV memory + memory files |
| `src/routes/browser.ts` | 399L | 38 | browser primitive/tab/debug routes + web-ai render/send/poll/watch/sessions/capabilities/context routes |
| `src/routes/jaw-memory.ts` | 239L | 11 | jaw memory search/read/save/list/init/reflect/flush/soul/soul-activate/bootstrap |
| `src/routes/orchestrate.ts` | 394L | 9 | reset/state/workers/snapshot/queue cancel/queue steer/dispatch/worker result/state PUT |
| `src/routes/messaging.ts` | 222L | 6 | upload/file-open/voice/telegram/channel/discord send |
| `src/routes/employees.ts` | 96L | 5 | employee CRUD + reset |
| `src/routes/skills.ts` | 74L | 5 | skills list/read/enable/disable/reset |
| `src/routes/avatar.ts` | 146L | 4 | avatar summary + agent/user image upload/delete/read |
| `src/routes/heartbeat.ts` | 43L | 2 | heartbeat GET + validated PUT |
| `src/routes/i18n.ts` | 26L | 2 | language list + locale bundle |
| `src/routes/quota.ts` | 344L | — | `settings.ts`가 호출하는 quota reader helper |
| `src/routes/types.ts` | 3L | — | shared `AuthMiddleware` type |

### 등록 순서 (`server.ts`)

```text
employees → heartbeat → skills → jaw-memory → orchestrate
→ memory → settings → messaging → avatar → browser → i18n
```

라우트 모듈은 `server.ts:485-496` 부근에서 등록된다.

---

## Base Route Surface (`server.ts`)

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/` | `public/dist/index.html`이 있으면 Vite build를 서빙, 없으면 static fallback |
| `GET` | `/api/health` | `{ ok, version, uptime }` |
| `GET` | `/api/session` | 현재 main session row 반환 |
| `GET` | `/api/messages` | `includeTrace=1|true|yes`면 trace 포함 메시지 조회 |
| `GET` | `/api/messages/latest` | 가장 최근 메시지 스냅샷 반환 |
| `GET` | `/api/runtime` | uptime, activeAgent, queuePending |
| `GET` | `/api/auth/token` | same-origin/CLI용 Bearer token bootstrap |
| `POST` | `/api/command` | slash command 실행 |
| `GET` | `/api/commands` | 인터페이스별 command palette 데이터 |
| `POST` | `/api/message` | 일반 프롬프트 제출 |
| `POST` | `/api/stop` | 현재 실행 중 agent 모두 종료 |
| `POST` | `/api/clear` | UI-only clear broadcast, DB 메시지는 유지 |
| `POST` | `/api/session/reset` | 메시지 삭제 + session reset |

### 서버 헬퍼

| Function | 역할 |
| --- | --- |
| `findProjectRoot()` | `package.json` 기준 프로젝트 루트 탐색 |
| `getRuntimeSnapshot()` | uptime/activeAgent/queuePending 스냅샷 |
| `clearSessionState()` | ownership generation 증가 + 메시지 삭제 + `clear` broadcast |
| `resetSessionOnly()` | session ID만 비우고 history 유지 + `session_reset` broadcast |
| `resolveRequestLocale()` | body/query/Accept-Language/settings 순으로 locale 확정 |
| `applySettingsPatch()` | runtime patch 적용 + fallback state reset hook |
| `makeWebCommandCtx()` | Web용 `makeCommandCtx('web', ...)` 래퍼 |
| `requireAuth()` | loopback bypass + optional private-LAN bypass + non-local Bearer 검사 |

---

## Startup / Shutdown

## 초기화 순서

```text
ensureDirs()
→ mkdir public
→ runMigration(projectRoot)
→ loadSettings()
→ DB quick_check
→ stale employee sessions clear
→ orphan jaw-emp-* tmp dir cleanup
→ syncMainSessionToSettings()
→ ensureMemoryRuntimeReady()
→ permissions safe→auto migration
→ initPromptFiles() / regenerateB()
→ stale/non-default orc_state reset/prune
→ express/http/ws 생성
→ middleware + base routes + route modules + errorHandler
→ watchHeartbeatFile()
→ server.listen(bindHost)
→ loadLocales()
→ initMcpConfig() / ensureWorkingDirSkillsLinks() / copyDefaultSkills()
→ hydrateTargetsFromSettings() / initActiveMessagingRuntime()
→ seedDefaultEmployees()
→ startHeartbeat()
→ employee name/model migration
```

### listen 시점 후처리

- `settings.port`를 실제 listen port로 다시 저장한다.
- `JAW_OPEN_BROWSER=1`이면 테스트 환경이 아닐 때만 브라우저를 auto-open 한다.
- MCP/skills 링크 충돌이 있으면 `~/.cli-jaw/backups/skills-conflicts`로 백업 이동한다.
- 직원이 비어 있으면 default employees를 seed 한다.
- 한국어 직원명(`프런트`, `백엔드`, `문서` 등)을 영문명으로 마이그레이션한다.
- 레거시 Claude employee model 값을 alias(`sonnet`, `opus`, `sonnet[1m]`, `opus[1m]`)로 정규화한다.

### 종료 처리

- `SIGTERM`/`SIGINT`에서 heartbeat 중지, 모든 agent 종료, active `orc_state` reset, messaging runtime shutdown 시도, WebSocket/HTTP close, SQLite close를 수행한다.
- 5초 내 종료가 끝나지 않으면 force exit 한다.

---

## Security / Guards

### 네트워크 가드

- 기본 서버 bind는 `127.0.0.1`이지만 `settings.network.bindHost`, `JAW_LAN_MODE=1`, reverse-proxy mode에 따라 `0.0.0.0` bind가 가능하다.
- `ALLOWED_HOSTS`/`ALLOWED_ORIGINS`는 loopback을 기본 허용하고, LAN mode/bypass가 켜졌을 때 private network origin/host를 허용한다.
- WebSocket handshake도 동일한 host/origin 검사를 거친다.

### 인증

- mutation route 71개는 모두 `requireAuth`로 보호된다.
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

## REST API

| Category | Endpoints |
| --- | --- |
| Core/Auth | `GET /api/health` `GET /api/session` `GET /api/messages` `GET /api/messages/latest` `GET /api/runtime` `GET /api/auth/token` `POST /api/message` `POST /api/stop` `POST /api/clear` `POST /api/session/reset` |
| Commands | `POST /api/command` `GET /api/commands?interface=` |
| Settings/Prompt | `GET/PUT /api/settings` `GET /api/codex-context` `GET/PUT /api/prompt` `GET /api/prompt-templates` `PUT /api/prompt-templates/:id` `GET/PUT /api/heartbeat-md` |
| MCP/CLI/Quota | `GET/PUT /api/mcp` `POST /api/mcp/sync` `POST /api/mcp/install` `POST /api/mcp/reset` `GET /api/cli-registry` `GET /api/cli-status` `GET /api/quota` `POST /api/copilot/refresh` |
| Heartbeat | `GET/PUT /api/heartbeat` |
| Browser | `POST /api/browser/start` `POST /api/browser/stop` `GET /api/browser/status` `GET /api/browser/snapshot` `POST /api/browser/screenshot` `POST /api/browser/act` `POST /api/browser/vision-click` `POST /api/browser/navigate` `POST /api/browser/reload` `POST /api/browser/resize` `GET /api/browser/tabs` `GET /api/browser/active-tab` `POST /api/browser/tab-switch` `POST /api/browser/tab-new` `POST /api/browser/tab-close` `POST /api/browser/tab-cleanup` `POST /api/browser/evaluate` `GET /api/browser/text` `GET /api/browser/dom` `GET /api/browser/console` `GET /api/browser/network` `POST /api/browser/wait-for-selector` `POST /api/browser/wait-for-text` `POST /api/browser/web-ai/render` `POST /api/browser/web-ai/context-dry-run` `POST /api/browser/web-ai/context-render` `GET /api/browser/web-ai/status` `POST /api/browser/web-ai/send` `GET /api/browser/web-ai/poll` `GET /api/browser/web-ai/watch` `GET /api/browser/web-ai/watchers` `GET /api/browser/web-ai/sessions` `POST /api/browser/web-ai/sessions/prune` `GET /api/browser/web-ai/notifications` `GET /api/browser/web-ai/capabilities` `POST /api/browser/web-ai/query` `POST /api/browser/web-ai/stop` `GET /api/browser/web-ai/diagnose` |
| Orchestrate | `POST /api/orchestrate/reset` `GET /api/orchestrate/state` `GET /api/orchestrate/workers` `GET /api/orchestrate/snapshot` `DELETE /api/orchestrate/queue/:id` `POST /api/orchestrate/queue/:id/steer` `POST /api/orchestrate/dispatch` `GET /api/orchestrate/worker/:agentId/result` `PUT /api/orchestrate/state` |
| Employees | `GET /api/employees` `POST /api/employees` `PUT /api/employees/:id` `DELETE /api/employees/:id` `POST /api/employees/reset` |
| Skills | `GET /api/skills` `GET /api/skills/:id` `POST /api/skills/enable` `POST /api/skills/disable` `POST /api/skills/reset` |
| Memory Runtime / KV / Files | `GET /api/memory/status` `POST /api/memory/reindex` `POST /api/memory/bootstrap` `GET /api/memory/files` `GET /api/memory` `POST /api/memory` `DELETE /api/memory/:key` `GET /api/memory-files` `GET /api/memory-file` `GET /api/memory-files/:filename` `DELETE /api/memory-file` `DELETE /api/memory-files/:filename` `PUT /api/memory-files/settings` |
| Jaw Memory | `GET /api/jaw-memory/search` `GET /api/jaw-memory/read` `POST /api/jaw-memory/save` `GET /api/jaw-memory/list` `POST /api/jaw-memory/init` `POST /api/jaw-memory/reflect` `POST /api/jaw-memory/flush` `GET /api/jaw-memory/soul` `POST /api/jaw-memory/soul/activate` `POST /api/jaw-memory/soul` `POST /api/soul/bootstrap` |
| Messaging | `POST /api/upload` `POST /api/file/open` `POST /api/voice` `POST /api/telegram/send` `POST /api/channel/send` `POST /api/discord/send` |
| Avatar | `GET /api/avatar` `POST /api/avatar/:target/upload` `DELETE /api/avatar/:target/image` `GET /api/avatar/:target/image` |
| i18n | `GET /api/i18n/languages` `GET /api/i18n/:lang` |

> 실제 코드(`server.ts` + `src/routes/*.ts`)에서 추출한 총 126개 route handler 기준이다. 이 중 API 엔드포인트는 125개이고, 나머지 1개는 `/` 엔트리이다. Browser API 38개는 `src/routes/browser.ts`에서 등록된다. 이 중 POST/PUT/DELETE mutation endpoint 71개는 모두 `requireAuth` 보호를 받고, `GET /api/auth/token`은 `Sec-Fetch-Site`가 `same-origin|none`이 아닐 때 `403`을 반환한다.

### 최근 surface drift

- `jaw-memory`는 이제 `flush`, `soul` read/write, `soul/activate`, `POST /api/soul/bootstrap`까지 포함한 11개 route다.
- avatar API가 `registerAvatarRoutes()`로 연결되어 agent/user custom image를 관리한다.
- `/api/session/reset`이 base route로 추가되어 `/clear`와 의미가 분리됐다.
- orchestrate API는 queue cancel / queue steer / worker result 조회까지 포함한 9개 route이며, 이전 `continue` route는 현재 코드 표면에 없다.
- browser API는 primitive/tab/debug 라우트와 web-ai provider automation 라우트를 합쳐 38개 route로 확장됐다.

---

## Selected Route Notes

### `/api/command`

- body `text`를 500자까지 자른 뒤 `parseCommand()`로 해석한다.
- locale은 body/query/Accept-Language/settings 순으로 정해지고 `Content-Language`가 세팅된다.
- command가 아니면 `400 { code: 'not_command' }`.

### `/api/commands`

- `COMMANDS`에서 `hidden` 제외 + `interface` 매칭 결과만 내려준다.
- 응답에는 `name`, `desc`, `args`, `category`, `aliases`가 포함된다.

### `/api/settings`

- `GET`은 live `settings`를 반환하되 STT secrets(`geminiApiKey`, `openaiApiKey`)를 비우고 `*KeySet`/`*KeyLast4` 메타만 노출한다.
- `PUT`은 `applyRuntimeSettingsPatch()`를 거치며 `perCli`, `activeOverrides`, `telegram`, `discord`, `memory`, `stt`, `tui`, `messaging`, `network` 같은 nested object는 merge semantics를 따른다.
- `showReasoning`은 top-level scalar setting이며 `/thought` command와 Gemini thought visibility가 이 값을 공유한다.

### `/api/message`

- `submitMessage()`를 통해 idle 즉시 실행 / busy 큐잉 / reset/continue intent 분기를 공통 처리한다.
- reject 시 `409 busy` 또는 `400` reason을 반환한다.

### `/api/clear` vs `/api/session/reset`

- `/api/clear`: UI-only clear broadcast. DB 메시지 삭제 없음.
- `/api/session/reset`: `clearMainSessionState()` 호출. 메시지 삭제 + session cleared.

### `/api/file/open`

- `:line[:col]` suffix가 붙은 문서형 경로를 허용한다.
- exact path가 없을 때만 suffix를 strip 해 fallback 해석한다.
- 문서형 확장자는 reveal, 일반 파일은 상위 폴더 open, 디렉터리는 디렉터리 자체 open 전략을 쓴다.

### `/api/heartbeat`

- `PUT`은 `jobs` 배열 전체를 검증한다.
- invalid schedule이면 `400`과 함께 `code`, `detail`, `index`, `jobId`를 포함해 반환한다.

### `/api/quota`

- 응답 키: `claude`, `codex`, `gemini`, `opencode`, `copilot`.
- `opencode`는 현재 `{ authenticated: true }` 고정 응답이다.

### `/api/orchestrate/dispatch`

- boss-scoped `x-jaw-boss-token`이 필수다. employee spawn 환경에서는 이 토큰이 제거되므로 직원이 다시 dispatch하는 흐름은 서버에서 `403`으로 막힌다.
- PABCD A/B/C 상태에서는 phase가 각각 Plan Audit/Verifier 쪽으로 매핑된다. 특히 B phase에서는 implementation wording을 delegation guard가 차단하고, worker는 READ-ONLY verifier로만 동작해야 한다.
- 현재 plan이 있으면 dispatch body 상단에 `## Approved Plan`으로 자동 주입된다. worker에게 별도 plan 파일을 읽으라고 지시하지 않는다.

---

## WebSocket Events

연결 시 서버는 현재 상태 스냅샷을 먼저 보낸다: `agent_status`, `queue_update`, 비-IDLE `orc_state`. 현재 브로드캐스트되는 WebSocket 이벤트는 22종이다.

| Type | 설명 |
| --- | --- |
| `agent_status` | running/done/error/evaluating + agentId/phase |
| `agent_tool` | tool/thinking/search 진행 step |
| `agent_output` | 라이브 text chunk preview |
| `agent_done` | 최종 응답 + toolLog + origin |
| `agent_retry` / `agent_fallback` | retry/fallback 안내 |
| `agent_smoke` | smoke auto-continue 안내 |
| `queue_update` | 대기열 길이 갱신 |
| `clear` / `session_reset` | UI clear / session reset broadcast |
| `new_message` | Telegram/Discord inbound message |
| `orc_state` | PABCD 상태 변경 |
| `orchestrate_done` | orchestration 완료/실패 |
| `agent_added` / `agent_updated` / `agent_deleted` | employee CRUD 반영 |
| `memory_status` | memory sidebar / runtime 상태 갱신 신호 |
| `system_notice` | compact refresh 같은 시스템 공지 |
| `heartbeat_pending` | pending heartbeat job 수 |
| `worker_stalled` / `worker_disconnected` / `worker_timeout` | distributed worker 상태 변화 |

- 새 연결 시 서버는 필요하면 `agent_status`, `queue_update`, non-IDLE `orc_state`를 먼저 push 한다.
- 실제 broadcast 함수는 `src/core/bus.ts`의 `broadcast(type, data)` 하나다. WebSocket 전송과 내부 listener fan-out을 동시에 처리한다.
- Web UI가 소비하는 이벤트별 상세 흐름은 [stream-events.md](stream-events.md)에 정리한다.
