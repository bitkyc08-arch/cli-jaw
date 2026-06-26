---
created: 2026-03-28
tags: [cli-jaw, telegram, messaging, heartbeat]
aliases: [Telegram and Heartbeat, CLI-JAW Telegram, messaging runtime]
---

> 📚 [INDEX](INDEX.md) · [에이전트 실행 ↗](agent_spawn.md) · [인프라 ↗](infra.md) · **텔레그램 & 하트비트**

# Telegram & Heartbeat — telegram/bot.ts · telegram/forwarder.ts · telegram/telegram-file.ts · telegram/voice.ts · telegram/hub-callback.ts · messaging/runtime.ts · messaging/send.ts · messaging/thread-target.ts · manager/telegram-hub/* · memory/heartbeat.ts · memory/heartbeat-schedule.ts

> Telegram transport (standalone + hub-member) + Dashboard forum-topic hub + shared messaging runtime + forwarder lifecycle + origin filtering + voice STT
> 현재 Telegram/Discord는 `src/messaging/`을 공유하며, settings restart는 `core/runtime-settings.ts`에서 한 번에 처리된다
> v5 Update: `forwardAll` 토글은 Telegram/Discord 각각의 channel setting으로 분리됨
> v6 Update: forum **topic-aware** programmatic send (P0) + Dashboard **Telegram Hub** — one bot, many topics → many instances (P1–P3)

---

## 공통 메시징 레이어

### `src/messaging/runtime.ts`

- `registerTransport('telegram' | 'discord', ...)`로 각 transport의 init/shutdown을 등록한다
- `settings.messaging.lastActive/latestSeen`를 저장하고, `hydrateTargetsFromSettings()`로 복원한다
- `restartMessagingRuntime()`는 active channel 또는 active-channel config가 바뀔 때만 재시작한다
- `clearTargetState()`는 stale routing을 지우고, `send.ts`가 fallback target을 다시 계산하게 만든다
- restart 전에 stale target을 비우므로 이전 thread/channel로 재전송되는 것을 막는다

### `src/messaging/send.ts`

- `sendChannelOutput()`는 `explicit target → validated lastActive → validated latestSeen → configured fallback` 순으로 target을 고른다
- `validateTarget()`는 Telegram allowedChatIds와 Discord channelIds / thread parent 허용을 둘 다 검사한다
- `registerSendTransport()`로 채널별 outbound sender를 주입한다

### `src/messaging/thread-target.ts`

- `threadIdNumber(target)` — programmatic Telegram sends용 `message_thread_id` 추출
- `threadId`가 없거나 General topic (`'1'`)이면 `undefined` → wire payload에서 필드 생략 (DM/비포럼 그룹 동작 불변)
- 실제 topic id는 `n > 1`일 때만 전달
- 사용처: `telegram/bot.ts` `telegramSendHandler`, legacy `/api/telegram/send`, hub `sendToTopic`

### Remote channel structured elicitation guard

- 21 Elicitation은 Web UI main DOM 전용 상호작용이다.
- Telegram/Discord origin은 `src/orchestrator/pipeline.ts`에서 per-turn prompt guard를 받아 `elicitation` / `choice-buttons` / `search-results` fenced block 출력을 금지한다.
- A1 system prompt는 이 채널별 규칙 때문에 수정하지 않는다. prompt-cache 안정성을 유지하기 위해 origin-aware guard는 user prompt 조립 경로에서만 붙는다.
- 모델이 그래도 remote 응답에 `elicitation` / `choice-buttons` fence를 출력하면 `orchestrate_done` broadcast 직전에 plain text numbered question fallback으로 변환한다.
- 모델이 remote 응답에 `search-results` fence를 출력하면 raw JSON fence를 그대로 보내지 않고 일반 텍스트 검색 결과 목록 또는 경고 fallback으로 변환한다.
- 현재 Telegram `callback_query` / inline keyboard와 Discord message components는 구현하지 않는다. native remote buttons는 후속 별도 기능이다.

### `core/runtime-settings.ts`

- `applyRuntimeSettingsPatch()`는 `telegram`, `discord`, `messaging` 패치를 deep merge 하고 runtime restart를 트리거한다
- workingDir 변경이 있으면 MCP/skills/regenerateB까지 함께 갱신한다

---

## telegram/bot.ts — Telegram Bot + Forwarder Lifecycle + Voice + Hub-member relay (707L)

| Function | 역할 |
| --- | --- |
| `initTelegram()` | Bot 생성, allowlist, mention gating, handlers, forwarder lifecycle |
| `shutdownTelegram()` | bot stop + forwarder detach |
| `makeTelegramCommandCtx()` | Telegram용 ctx 생성, `applyRuntimeSettingsPatch()` 경로 사용 |
| `syncTelegramCommands(bot)` | `getTelegramMenuCommands()` 기반 default + locale `setMyCommands` |
| `sendTelegramText()` | outbound text send |
| `buildTelegramTarget()` | `RemoteTarget` 생성 (`threadId` = `message_thread_id` when present) |
| `attachTelegramForwarder()` / `detachTelegramForwarder()` | broadcast listener lifecycle |
| `invalidateTelegramSendClient()` | send-only bot cache 무효화 (`runtime-settings` patch 시) |

### Thread-aware programmatic send (P0)

- `registerSendTransport('telegram', telegramSendHandler)` 경로가 `threadIdNumber(req.target)`로 `message_thread_id`를 text/file send에 전달한다
- Interactive `ctx.reply`는 grammY가 자동으로 thread를 유지하므로 handler 경로와 분리된다
- `telegram-file.ts` `sendTelegramFile(..., { threadId })`도 동일 semantics

### Hub-member outbound relay (P2b)

`settings.telegramHub.mode === 'hub-member'`이고 `req.target.channel === 'telegram'`이면 인스턴스 자체 봇 대신 Dashboard hub callback으로 relay:

```text
telegramSendHandler (hub-member):
  base = resolveHubCallback(settings.telegramHub.hubCallbackUrl)  // src/telegram/hub-callback.ts
  POST {base}/api/dashboard/telegram-hub/outbound
    body { chatId, threadId, type, text?, filePath?, caption? }
```

- `resolveHubCallback()` — loopback `http:` only; https·credentials·non-loopback → `http://127.0.0.1:24576` fallback
- Hub mode invariant: forum 그룹의 **동일 bot token**은 long-poll **한 곳**만 가능 (409). Hub 그룹에 묶인 인스턴스는 `telegram.enabled=false` 유지

### 현재 동작

```text
initTelegram():
  1. detachTelegramForwarder()
  2. 기존 bot stop + null
  3. Grammy Bot 인스턴스 생성
  4. allowlist / allowedChatIds 로드
  5. group/supergroup @botUsername gating
  6. logging/allowlist/mention gating middleware 등록
  7. bot.command('start'/'id') + text/photo/document/voice handlers 등록
  8. settings.telegram.forwardAll !== false → attachTelegramForwarder(bot)
  9. syncTelegramCommands()
  10. bot.api.getMe() → botUsername 캐시
  11. bot.start()
```

- 실제 bot command handler는 `/start`, `/id` 2개다. 나머지 slash command는 `message:text`에서 `parseCommand()` → `executeCommand()`로 처리한다
- text handler는 `@botUsername` 멘션을 자동 제거한다
- photo/document handler는 Telegram file download → `saveUpload()` → `buildMediaPrompt()` → `tgOrchestrate()`로 이어진다
- voice handler는 `telegram/voice.ts` → guarded `downloadTelegramFile()` → `lib/stt.ts` → `tgOrchestrate()`로 이어진다
- inbound photo/document downloads pass media-specific size hints to `downloadTelegramFile()` before files are saved.
- 현재 `callback_query`/inline keyboard callback handler는 `src/telegram/*`에 없다
- `applySettings()`는 `bumpSessionOwnershipGeneration()` 이후 `applyRuntimeSettingsPatch()`를 호출한다
- `markChatActive()`는 `allowedChatIds` 자동 저장과 `lastActive/latestSeen` 갱신을 같이 처리한다
- transport/send transport 등록은 모듈 로드 시점에 즉시 일어난다

### 의존 모듈

`core/bus` · `core/config` · `core/main-session` · `core/runtime-settings` · `core/employees` · `agent/spawn` · `orchestrator/pipeline` · `orchestrator/collect` · `cli/commands` · `messaging/runtime` · `messaging/send` · `lib/upload`

---

## telegram/forwarder.ts — Telegram Forwarder (105L)

| Function | 역할 |
| --- | --- |
| `createForwarderLifecycle()` | attach/detach 중복 등록 방지 |
| `createTelegramForwarder()` | `agent_done`를 Telegram 채널로 forward |
| `markdownToTelegramHtml()` | Markdown → Telegram HTML 변환 |
| `chunkTelegramMessage()` | 4096자 단위 분할 |
| `escapeHtmlTg()` | Telegram HTML escape |

### 핵심 포인트

- `shouldSkip(data)`로 Telegram-origin 결과를 제외한다
- `broadcast` listener는 named handler 기준으로 제거된다
- `forwardAll`이 꺼져 있으면 bot 메시지는 받고, agent_done forward는 하지 않는다
- outbound 텍스트는 Telegram HTML로 변환한 뒤 4096자 청크로 보낸다

---

## telegram/voice.ts — Voice Message STT Handler (40L)

| Function | 역할 |
| --- | --- |
| `handleVoice(ctx)` | voice 메시지 → Telegram API download → `lib/stt.ts` 전사 → `tgOrchestrate(ctx, text)` |

### 흐름

```text
bot.ts on("message:voice"):
  1. ctx.reply("🎤 ...")
  2. getFile() → download URL 생성
  3. node-fetch로 .ogg 다운로드 → tmp 저장
  4. transcribeVoice(tmpPath, 'audio/ogg')
  5. 빈 결과 → ctx.reply(t('tg.voiceEmpty'))
  6. 성공 → tgOrchestrate(ctx, transcribedText)
  7. finally → tmp 파일 삭제
```

### 의존 모듈

`lib/stt` · `lib/upload` · `telegram/bot` (`tgOrchestrate`)

---

## telegram/telegram-file.ts — Telegram File Send (133L)

| Export | 역할 |
| --- | --- |
| `TELEGRAM_LIMITS` | file size limits |
| `validateFileSize(path, type)` | 20MB size gate |
| `classifyUpstreamError(err)` | upstream error classification |
| `sendTelegramFile(...)` | file send + exponential backoff retry; optional `{ threadId }` for forum topics |

---

## telegram/hub-callback.ts — Hub callback URL SSRF guard (19L)

| Export | 역할 |
| --- | --- |
| `resolveHubCallback(configured?)` | hub-member outbound의 callback origin 결정; loopback `http`만 허용 |

- Default: `http://127.0.0.1:24576` (`DASHBOARD_DEFAULT_PORT`)
- Path/query는 strip; origin만 반환

---

## Telegram Hub (Dashboard) — forum topic → instance routing

> Dashboard manager server(`src/manager/server.ts`, port `24576`)가 **단일 bot token + 단일 forum supergroup**을 소유하고, topic(`message_thread_id`)별로 managed instance(3457–3506)에 라우팅한다. **Mode A**(per-instance bot + P0 thread-aware send)와 공존.

### Two operating modes

| Mode | Who polls Telegram | Inbound | Outbound |
| --- | --- | --- | --- |
| **Standalone** (`telegram.enabled=true`) | Each instance's `initTelegram()` | Instance bot handlers | Instance `telegramSendHandler` (thread-aware) |
| **Hub** (dashboard `telegramHub.enabled`) | `startHubBot()` only | Hub `hub-bot.ts` → `POST /api/message` on mapped port | Instance `hub-member` send → `POST …/telegram-hub/outbound` → hub `sendToTopic` |

### Module map

| Path | 역할 |
| --- | --- |
| `src/manager/telegram-hub/types.ts` | `TelegramHubConfig`, `ThreadRoute` |
| `src/manager/telegram-hub/routing-store.ts` | Registry `telegramHub` CRUD |
| `src/manager/telegram-hub/hub-bot.ts` | Hub grammY bot: inbound intercept, instance forward, `sendToTopic` |
| `src/manager/routes/telegram-hub.ts` | Loopback-only REST: config CRUD + outbound relay |
| `public/manager/src/settings/pages/TelegramHub.tsx` | Manager settings UI |

### Routing model

```text
threadKey(message_thread_id): id > 1 → String(id); else → '1' (General)

Inbound (hub-bot):
  1. chatId must equal config.chatId
  2. Hub slash commands → handleHubCommand (no @mention gate)
  3. route = resolveRoute(chatId, threadId) — none → "미연결" (no defaultPort auto-route)
  4. POST http://127.0.0.1:{port}/api/message { prompt, target: { channel, targetId, threadId } }

Outbound: hub-member → POST /api/dashboard/telegram-hub/outbound → sendToTopic
```

### Hub bot commands

| Command | Auth | Behavior |
| --- | --- | --- |
| `/setthread` | read | 현재 topic 바인딩 표시 |
| `/setthread <port>` | admin | `(chatId, threadId) → port` upsert; port ∈ 3457–3506 |
| `/setthread off` | admin | 현재 topic route 삭제 |
| `/threads` | read | 이 그룹의 전체 route 목록 |
| `/hubhelp` | read | command help |

### Hub HTTP API (loopback-only)

Mounted at `/api/dashboard/telegram-hub` (`loopbackOnly` middleware).

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/` | — | `{ ok, config }` — token redacted |
| `PUT` | `/` | `{ enabled?, token?, chatId?, defaultPort? }` | patches registry; restarts hub bot |
| `POST` | `/routes` | `ThreadRoute` | upsert route |
| `DELETE` | `/routes/:chatId/:threadId` | — | remove route |
| `POST` | `/outbound` | `{ chatId, threadId, type, text?, filePath?, caption? }` | instance → hub → topic relay |

### Dashboard settings UI (`TelegramHub.tsx`)

- Sidebar: **Settings → Channels → Telegram Hub**
- Fields: Enable hub, Bot token, Forum group chat ID, Default port
- Routes table: read-only list + Delete; add/bind는 Telegram `/setthread`만

### Instance hub-member settings (manual today)

```jsonc
{
  "telegram": { "enabled": false },
  "telegramHub": { "mode": "hub-member", "hubCallbackUrl": "http://127.0.0.1:24576" }
}
```

---

## cli/command-context.ts — Remote Patch Whitelist

| Telegram/Discord 허용 패치 | 설명 |
| --- | --- |
| `{ fallbackOrder: [...] }` | fallback order 변경 |
| `{ cli: '...' }` | active CLI 변경 |
| `{ perCli: { ... } }` | per-CLI model/effort patch |
| `{ memory: { ... } }` | memory 설정 patch |
| `{ telegram: { ... } }` | Telegram channel setting patch |
| `{ discord: { ... } }` | Discord channel setting patch |

- `telegram` / `discord` 인터페이스는 위 whitelist만 허용한다
- 허용되지 않은 패치는 `tg.settingsUnsupported` 또는 `dc.settingsUnsupported`로 거절된다
- 실제 merge는 `core/settings-merge.ts` + `core/runtime-settings.ts`가 담당한다

---

## cli/handlers-runtime.ts — `/forward` Handler

| Function | 역할 |
| --- | --- |
| `forwardHandler(args, ctx)` | `/forward on|off`로 현재 인터페이스의 `forwardAll` 토글 |

- Telegram 인터페이스에서는 `settings.telegram.forwardAll`
- Discord 인터페이스에서는 `settings.discord.forwardAll`
- `src/cli/handlers.ts`는 이 핸들러를 re-export만 한다

---

## memory/heartbeat.ts — Scheduled Jobs (205L)

| Function | 역할 |
| --- | --- |
| `startHeartbeat()` | cron-like 주기 작업 시작 |
| `stopHeartbeat()` | 작업 중지 |
| `runHeartbeatJob(job)` | 단일 작업 실행 (busy guard) |
| `watchHeartbeatFile()` | fs.watch debounce — 파일 변경시 재로드 |

### 의존 모듈

`core/config` · `orchestrator/collect` · `messaging/send` · `memory/heartbeat-schedule`

### 작업 스케줄

- 설정: `~/.cli-jaw/heartbeat.json`
- 각 작업: `id`, `name`, `enabled`, `schedule`, `prompt`
- `schedule`은 `{ kind: 'every', minutes }` 또는 `{ kind: 'cron', cron, timeZone? }`
- busy guard: 이전 작업 실행 중이면 버리지 않고 `pendingJobs` 큐에 넣는다
- 실행 프롬프트 앞에는 memory search 지시가 자동으로 붙는다
- 결과 전송은 Telegram 고정이 아니라 `sendChannelOutput({ channel: 'active', ... })`를 통해 현재 활성 채널로 간다

---

## memory/heartbeat-schedule.ts — Schedule Parsing & Validation (410L)

| Function | 역할 |
| --- | --- |
| `normalizeHeartbeatSchedule()` | `every`/`cron` 입력 정규화 |
| `validateHeartbeatScheduleInput()` | API 저장 전 스케줄 검증 |
| `describeHeartbeatSchedule()` | 사람이 읽는 schedule 문자열 생성 |
| `matchesHeartbeatCron()` | timezone-aware cron 매칭 |
| `formatHeartbeatNow()` | 잡 프롬프트용 현재 시간 문자열 생성 |

### API 표면

- `GET /api/heartbeat`는 현재 `heartbeat.json`을 반환한다
- `PUT /api/heartbeat`는 schedule 검증 후 저장하고 `startHeartbeat()`를 다시 호출한다
- `watchHeartbeatFile()`는 `heartbeat.json` 파일 변경을 debounce 후 자동 재로드한다
