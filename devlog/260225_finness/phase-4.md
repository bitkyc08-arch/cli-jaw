# Phase 4 (finness): Copilot ACP 응답 누적 버그

> 문제: Copilot 1번 응답이 2번, 3번 메시지에도 계속 붙어서 출력됨

---

## 현상

Copilot 호출 시:
- 1번 호출: "안녕하세요! 무엇을 도와드릴까요?"
- 2번 호출: "안녕하세요! 무엇을 도와드릴까요? + 2번 응답" (1번 텍스트 포함)
- 3번 호출: "1번 + 2번 + 3번 응답" (전부 누적)

---

## 가능한 원인

### 가설 A: ctx.fullText 미초기화
`ctx.fullText`가 ACP session 간에 리셋 안 됨.
하지만 코드상 ACP branch는 매번 `new AcpClient()` → `spawn()` → `shutdown()` → exit으로 매번 새 ctx 생성됨.

### 가설 B: ACP session/update가 전체 히스토리 리플레이
ACP `session/update` 이벤트가 **현재 turn**의 텍스트가 아니라 **세션 전체 텍스트**를 다시 보낼 수 있음.
`loadSession(session_id)`로 이전 세션을 복원하면, 이전 turn의 message_chunk까지 재전송.

### 가설 C: resume 로직 문제
`isResume` + `session.session_id`가 있으면 `loadSession()`으로 복원 → 이전 텍스트 재발송.

---

## 디버깅 계획

1. `DEBUG=1`로 서버 실행, ACP 이벤트 로그 확인
2. `session/update` 이벤트에서 `sessionUpdate` 타입별 카운트 확인
3. `agent_message_chunk`가 이전 turn 텍스트를 다시 보내는지 확인
4. `loadSession` vs `createSession` 시 동작 차이 확인

---

## 예상 수정

### 가설 B가 맞는 경우

`extractFromAcpUpdate()`에서 `agent_message_chunk` 처리 시, 현재 turn의 텍스트만 추출하도록 필터링.
또는 `ctx.fullText`를 마지막 `agent_done` 이후 텍스트만 사용.

### 가설 C가 맞는 경우

`session/update` 핸들러에서 `loadSession` 완료 전까지 이벤트 무시.
또는 매번 `createSession`만 사용 (이전 컨텍스트 불필요 시).
