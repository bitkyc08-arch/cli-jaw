# Telegram & Heartbeat — telegram/bot.ts · telegram/forwarder.ts · memory/heartbeat.ts

> 외부 인터페이스 (Telegram Bot) + 주기적 작업 스케줄 + forwarder lifecycle + origin 필터링
> Phase 20.6: telegram.ts → telegram/bot.ts, telegram-forwarder.ts → telegram/forwarder.ts, heartbeat.ts → memory/heartbeat.ts

---

## telegram/bot.ts — Telegram Bot + Forwarder Lifecycle (497L)

| Function                                              | 역할                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `initTelegram()`                                      | Bot 생성, allowlist, 핸들러, forwarder lifecycle 관리            |
| `attachTelegramForwarder(bot)`                        | **named handler** 등록 (1회만 허용)                             |
| `detachTelegramForwarder()`                           | 기존 forwarder 해제                                             |
| `createTelegramForwarder({ bot, getLastChatId, shouldSkip })` | **팩토리** — 테스트 가능한 forwarder 생성              |
| `orchestrateAndCollect()`                             | agent_done까지 수집 (idle timeout, agent_fallback 포함)         |
| `tgOrchestrate(ctx, prompt)`                          | TG → orchestrate → 응답 전송 (폴백 알림, origin 전달)          |
| `syncTelegramCommands(bot)`                           | `setMyCommands` 등록 (TG_EXCLUDED_CMDS 필터)                    |
| `makeTelegramCommandCtx()`                            | TG용 ctx 생성 (fallbackOrder만 변경 허용)                       |
| `ipv4Fetch(url, init)`                                | IPv4 강제 fetch                                                 |
| `escapeHtmlTg(text)`                                  | Telegram HTML 이스케이프                                        |
| `markdownToTelegramHtml(md)`                          | Markdown → Telegram HTML 변환                                   |
| `chunkTelegramMessage(text)`                          | 4096자 단위 메시지 분할                                         |
| `markChatActive(chatId)`                              | 활성 chatId Set 관리 + `allowedChatIds` 자동 저장 (persist)      |

### 의존 모듈

`core/bus` · `core/config` · `core/db` · `agent/spawn` · `orchestrator/pipeline` · `cli/commands` · `lib/upload`

### 초기화 흐름 (lifecycle 포함)

```text
initTelegram():
  1. detachTelegramForwarder()          ← 기존 forwarder 해제
  2. telegramBot 존재 시 stop() + null
  3. Grammy Bot 인스턴스 생성
  4. TELEGRAM_ALLOWLIST로 사용자 필터
  4.5. allowedChatIds 로드 (persist)
  5. 핸들러 등록:
     - on("message:text") → 슬래시 커맨드 or 일반 메시지
     - on("message:photo") → 사진 다운로드 → agent
     - on("message:document") → 파일 다운로드 → agent
  6. syncTelegramCommands() → setMyCommands 등록
  7. forwardAll !== false → attachTelegramForwarder(bot)
  8. bot.start()
```

### Forwarder Lifecycle

- **문제**: `initTelegram()` 재호출 시 익명 listener 중복 등록
- **해결**: `telegramForwarder` 모듈 전역 변수 + `detach → attach` 순서 보장

```text
initTelegram()
  → detachTelegramForwarder()  // removeBroadcastListener(fn)
  → ... bot 생성 ...
  → attachTelegramForwarder(bot)  // if (telegramForwarder) return (이미 등록)
```

### origin 기반 필터링 (tgProcessing 제거)

- `tgProcessing` 전역 bool **제거**
- `orchestrate(prompt, { origin: 'telegram', chatId })` → origin 메타 전달
- forwarder에서 `data.origin === 'telegram'` 제외
- 동시 다중 채팅에서도 정확한 필터링

---

## memory/heartbeat.ts — Scheduled Jobs (108L)

| Function               | 역할                                   |
| ---------------------- | -------------------------------------- |
| `startHeartbeat()`     | cron-like 주기 작업 시작               |
| `stopHeartbeat()`      | 작업 중지                              |
| `runHeartbeatJob(job)` | 단일 작업 실행 (busy guard)            |
| `watchHeartbeatFile()` | fs.watch debounce — 파일 변경시 재로드 |

### 의존 모듈

`core/config` · `telegram/bot` (re-export)

### 작업 스케줄

- 설정: `~/.cli-jaw/heartbeat.md` (마크다운 테이블)
- 각 작업: name, schedule (cron), prompt, enabled
- busy guard: 이전 작업 실행 중이면 스킵
- telegram 통해 결과 전송
