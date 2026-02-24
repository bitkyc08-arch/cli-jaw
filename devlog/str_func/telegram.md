# Telegram & Heartbeat — telegram.js · heartbeat.js

> 외부 인터페이스 (Telegram Bot) + 주기적 작업 스케줄

---

## telegram.js — Telegram Bot + Queue-First (403L)

| Function                     | 역할                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `initTelegram()`             | Bot 생성, allowlist, 핸들러 (텍스트/사진/문서), 슬래시디스패치 |
| `orchestrateAndCollect()`    | agent_done까지 수집 (idle timeout, agent_fallback 포함)        |
| `tgOrchestrate(ctx, prompt)` | TG → orchestrate → 응답 전송 (폴백 알림 표시)                  |
| `syncTelegramCommands(bot)`  | `setMyCommands` 등록 (TG_EXCLUDED_CMDS 필터)                   |
| `makeTelegramCommandCtx()`   | TG용 ctx 생성 (fallbackOrder만 변경 허용)                      |
| `ipv4Fetch(url, init)`       | IPv4 강제 fetch                                                |
| `escapeHtmlTg(text)`         | Telegram HTML 이스케이프                                       |
| `markdownToTelegramHtml(md)` | Markdown → Telegram HTML 변환                                  |
| `chunkTelegramMessage(text)` | 4096자 단위 메시지 분할                                        |
| `markChatActive(chatId)`     | 활성 chatId Set 관리                                           |

### 의존 모듈

`bus` · `config` · `db` · `agent` · `orchestrator` · `commands` · `upload`

### 초기화 흐름

```text
initTelegram():
  1. Grammy Bot 인스턴스 생성
  2. TELEGRAM_ALLOWLIST로 사용자 필터
  3. 핸들러 등록:
     - on("message:text") → 슬래시 커맨드 or 일반 메시지
     - on("message:photo") → 사진 다운로드 → agent
     - on("message:document") → 파일 다운로드 → agent
  4. syncTelegramCommands() → setMyCommands 등록
  5. bot.start()
```

### 슬래시 커맨드 통합

- `commands.js`의 `COMMANDS` 중 `interfaces`에 `telegram` 포함된 것만 등록
- `TG_EXCLUDED_CMDS`로 추가 제외 가능
- `makeTelegramCommandCtx()`로 TG 전용 ctx 생성 → `executeCommand()` 호출

---

## heartbeat.js — Scheduled Jobs (90L)

| Function               | 역할                                   |
| ---------------------- | -------------------------------------- |
| `startHeartbeat()`     | cron-like 주기 작업 시작               |
| `stopHeartbeat()`      | 작업 중지                              |
| `runHeartbeatJob(job)` | 단일 작업 실행 (busy guard)            |
| `watchHeartbeatFile()` | fs.watch debounce — 파일 변경시 재로드 |

### 의존 모듈

`config` · `telegram` (re-export)

### 작업 스케줄

- 설정: `~/.cli-claw/heartbeat.md` (마크다운 테이블)
- 각 작업: name, schedule (cron), prompt, enabled
- busy guard: 이전 작업 실행 중이면 스킵
- telegram 통해 결과 전송
