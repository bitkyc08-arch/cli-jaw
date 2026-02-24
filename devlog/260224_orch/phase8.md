# Phase 8: Telegram Queue-First + Timeout 확장

> **의존**: Phase 7 완료
> **검증일**: 2026-02-24

---

## 문제

1. **Telegram steer 문제**: 메시지 도착 시 `killActiveAgent('telegram-steer')` → 진행 중 작업 강제 종료
2. **IDLE_TIMEOUT 2분**: Codex 응답이 느려서 시간초과 빈번

## 해결

### 8-A: Queue-First

`tgOrchestrate()` 변경:

```diff
- killActiveAgent('telegram-steer')
- await waitForProcessEnd(3000)
+ enqueueMessage(prompt, 'telegram')
+ ctx.reply('📥 대기열에 추가됨 (N번째)')
```

큐 처리 후 응답 전달을 위해 `queueHandler` broadcast listener 등록 (5분 auto-cleanup).

### 8-B: IDLE_TIMEOUT 확장

`120000ms` (2분) → `240000ms` (4분)

## 변경 파일

| 파일              | 변경                                     |
| ----------------- | ---------------------------------------- |
| `src/telegram.js` | queue-first + queueHandler + 4분 timeout |
