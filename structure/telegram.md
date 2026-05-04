---
created: 2026-03-28
tags: [cli-jaw, telegram, messaging, heartbeat]
aliases: [Telegram and Heartbeat, CLI-JAW Telegram, messaging runtime]
---

> 📚 [INDEX](INDEX.md) · [에이전트 실행 ↗](agent_spawn.md) · [인프라 ↗](infra.md) · **텔레그램 & 하트비트**

# Telegram & Heartbeat — telegram/bot.ts · telegram/forwarder.ts · telegram/telegram-file.ts · telegram/voice.ts · messaging/runtime.ts · messaging/send.ts · memory/heartbeat.ts · memory/heartbeat-schedule.ts

> Telegram transport + shared messaging runtime + forwarder lifecycle + origin filtering + voice STT
> 현재 Telegram/Discord는 `src/messaging/`을 공유하며, settings restart는 `core/runtime-settings.ts`에서 한 번에 처리된다
> v5 Update: `forwardAll` 토글은 Telegram/Discord 각각의 channel setting으로 분리됨

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

### `core/runtime-settings.ts`

- `applyRuntimeSettingsPatch()`는 `telegram`, `discord`, `messaging` 패치를 deep merge 하고 runtime restart를 트리거한다
- workingDir 변경이 있으면 MCP/skills/regenerateB까지 함께 갱신한다

---

## telegram/bot.ts — Telegram Bot + Forwarder Lifecycle + Voice (632L)

| Function | 역할 |
| --- | --- |
| `initTelegram()` | Bot 생성, allowlist, mention gating, handlers, forwarder lifecycle |
| `shutdownTelegram()` | bot stop + forwarder detach |
| `makeTelegramCommandCtx()` | Telegram용 ctx 생성, `applyRuntimeSettingsPatch()` 경로 사용 |
| `syncTelegramCommands(bot)` | `getTelegramMenuCommands()` 기반 default + locale `setMyCommands` |
| `sendTelegramText()` | outbound text send |
| `buildTelegramTarget()` | `RemoteTarget` 생성 |
| `attachTelegramForwarder()` / `detachTelegramForwarder()` | broadcast listener lifecycle |

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
| `sendTelegramFile(...)` | file send + exponential backoff retry |

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
