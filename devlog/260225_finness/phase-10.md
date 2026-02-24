---
created: 2026-02-25
status: done
tags: [cli-claw, finness, phase-10, acp, timeout, copilot]
---
# Phase 10 (finness): ACP Activity-Based Timeout

> 목적: Copilot ACP `session/prompt`의 고정 5분 타임아웃을 활동 기반 idle timeout + 절대 상한으로 교체
> 범위: `src/acp-client.js`, `src/agent.js`, `tests/acp-client.test.js`

---

## 0) 문제

```
[acp:error] ACP request timeout: session/prompt (id=3)
```

- `session/prompt`에 고정 300s(5분) setTimeout
- copilot이 tool 호출, thinking 등 활발히 작업 중이어도 5분 넘으면 강제 끊김
- 다른 CLI(claude/codex/gemini/opencode)는 `child.on('close')` 기반이라 타임아웃 없음 → ACP 전용 문제

---

## 1) 해결

### 이중 타이머 (`requestWithActivityTimeout`)

| 타이머 | 값 | 동작 |
|--------|-----|------|
| **Idle timer** | 120s | `session/update` 이벤트 수신 시 리셋 |
| **Absolute timer** | 20min | 리셋 불가, 절대 상한 |

### 동작 원리

```text
copilot 프로세스 ──→ session/update (tool_call, thought, message 등)
                         ↓
                   agent.js가 수동 관찰
                         ↓
                   activityPing() 호출 → idle timer 리셋
```

- copilot에게 아무것도 보내지 않음 (관찰만)
- copilot이 120초 동안 아무 이벤트도 안 보내면 → idle timeout
- 이벤트가 계속 오면 20분까지 대기 가능

---

## 2) 변경 파일

### `src/acp-client.js` (253L → 311L)

- `requestWithActivityTimeout(method, params, idleMs, maxMs)` 메서드 추가
  - 반환: `{ promise, activityPing }` — 외부에서 `activityPing()` 호출 시 idle timer 리셋
  - 두 타이머 모두 cleanup 보장 (resolve/reject/process exit)
- `prompt()` 변경: `request()` → `requestWithActivityTimeout()` 사용
  - 반환값이 `{ promise, activityPing }`으로 변경 (기존: plain Promise)

### `src/agent.js` (607L → 611L)

- ACP flow에서 `prompt()` 반환값 destructure: `{ promise: promptPromise, activityPing }`
- `session/update` 핸들러에서 `promptActivityPing()` 호출 추가
- 모든 ACP 활동 이벤트(tool_call, thought, message, plan)가 idle timer 리셋

### `tests/acp-client.test.js` (97L → 138L)

- `requestWithActivityTimeout resolves and cleans up timers on response` — 정상 응답 + cleanup 검증
- `requestWithActivityTimeout rejects on idle timeout when no heartbeat` — idle timeout reject 검증

---

## 3) 검증

```
# tests 74
# pass 74
# fail 0
# duration_ms 174ms
```

기존 72개 + 신규 2개 전부 통과.

---

## 4) 네이밍 노트

- 기존 `heartbeat.js` = 크론잡 스케줄러 (N분마다 프롬프트 실행)
- 이번 추가분 = `activityPing` (copilot 이벤트 수동 관찰, 타이머 리셋)
- 혼동 방지를 위해 `heartbeat` 대신 `activityPing`으로 명명
