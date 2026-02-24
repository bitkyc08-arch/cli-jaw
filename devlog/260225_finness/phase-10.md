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

## 1) v1 → idle 120s에서도 재발

v1: `agent.js`에서 `session/update` 이벤트 수신 시 수동 `activityPing()` 호출 → idle 120s 리셋.

**재발 원인**: copilot이 MCP 호출/파일 읽기 등 tool 실행 중에는 `session/update`를 안 보냄 → 120초 무활동 → timeout.

```
💭 …write a script to push this to Notion…
[acp:error] ACP request timeout (idle 120s): session/prompt (id=3)
```

## 2) v2 해결 — `_handleLine` 내부 heartbeat

### 핵심 변경

heartbeat를 `agent.js` 외부 관찰에서 → `acp-client.js` 내부 `_handleLine`으로 이동:

```text
copilot 프로세스 ──→ ANY valid JSON-RPC message
                         ↓
                   _handleLine() 내부에서
                   this._activityPing?.() 자동 호출
                         ↓
                   idle timer 리셋
```

| 타이머 | 값 | 동작 |
|--------|-----|------|
| **Idle timer** | 1200s (20min) | 모든 JSON-RPC 메시지 + stderr 활동 시 리셋 |
| **Absolute timer** | 1200s (20min) | 리셋 불가, 절대 상한 |

### v1 대비 개선점

1. **`_handleLine`**: 모든 valid JSON 파싱 후 `_activityPing?.()` 호출 — `session/update`뿐 아니라 `session/request_permission` 등 모든 메시지가 리셋
2. **stderr**: copilot stderr 출력도 heartbeat 트리거
3. **agent.js 단순화**: 수동 `promptActivityPing` 변수 및 호출 제거 — acp-client 내부에서 자동 처리

---

## 3) 변경 파일

### `src/acp-client.js`

- `_handleLine`: JSON 파싱 성공 후 `this._activityPing?.()` 호출 추가
- `spawn()` stderr 핸들러: `this._activityPing?.()` 호출 추가
- `prompt()`: idle 1200s, max 1200s

### `src/agent.js`

- `session/update` 핸들러에서 수동 `promptActivityPing()` 호출 제거
- `promptActivityPing` 변수 및 `activityPing` destructure 제거
- `const { promise: promptPromise } = acp.prompt(prompt)` 로 단순화

### `tests/acp-client.test.js`

- `_handleLine resets idle timer via _activityPing on valid JSON` — 자동 heartbeat 검증 추가
- 기존 테스트 유지 (총 8개)

---

## 4) 검증

```
# tests 8 (acp-client.test.js)
# pass 8
# fail 0
```

전체 테스트 suite 개별 실행 전부 통과.

---

## 5) 네이밍 노트

- 기존 `heartbeat.js` = 크론잡 스케줄러 (N분마다 프롬프트 실행)
- `activityPing` = ACP JSON-RPC 메시지 수신 시 idle timer 리셋 (acp-client 내부)
