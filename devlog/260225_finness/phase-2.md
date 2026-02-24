# Phase 2 (P2): 테스트 확장/자동화 구현 계획 (2~3일)

## 전제
- 최소 회귀 테스트(events/telegram)는 `phase-1.1.md`에서 선반영 완료된 상태를 전제로 함

## 구현 반영 결과 (2026-02-24)
- [x] `tests/events.test.js`를 fixture 테이블 기반으로 확장 (Claude/Codex/Gemini/OpenCode)
- [x] `tests/fixtures/*`에 CLI별 분기 fixture 13개 추가 (`result/error`, `open_page`, `tool_result` 등)
- [x] `tests/telegram-forwarding.test.js`에 mixed-origin/error, long-chunk 전송, lifecycle idempotent 테스트 추가
- [x] `src/telegram-forwarder.js`에 `createForwarderLifecycle()` 추가 후 `src/telegram.js` forwarder attach/detach에 적용
- [x] CI 워크플로 추가: `.github/workflows/test.yml` (`npm ci --ignore-scripts` + `npm test`)
- [x] 로컬 검증 명령: `npm run test:events`, `npm run test:telegram`, `npm test`

## 목표
- 이벤트/텔레그램 테스트 커버리지 확장
- 동시성/라이프사이클 회귀까지 자동 차단
- 로컬 + CI 검증 루프 표준화

## 범위
- `tests/events.test.js`, `tests/fixtures/*`
- `tests/telegram-forwarding.test.js`
- `src/telegram-forwarder.js`, `src/telegram.js`
- `package.json` (집계 테스트)
- `.github/workflows/test.yml`

## 재검토 근거
- Node Test Runner: https://nodejs.org/api/test.html
- Node EventEmitter lifecycle: https://nodejs.org/api/events.html
- ACP spec(JSON-RPC 이벤트 구조): https://agentclientprotocol.com/protocol/specification

---

## 2-1. 이벤트 파서 fixture 확장

### 목적
- 단일 케이스가 아니라 CLI별/이벤트별 입력군으로 회귀를 막음

### 작업
- Claude: `stream_event`, `assistant`, `result`, `error`
- Codex/Gemini/OpenCode: 기존 파서 분기별 최소 fixture 추가
- fixture 기반 반복 테스트 테이블 도입

### 스니펫
```js
const cases = [
  { name: 'claude stream tool', cli: 'claude', fixture: 'claude-stream-tool.json', expect: 1 },
  { name: 'claude assistant fallback', cli: 'claude', fixture: 'claude-assistant-tool.json', expect: 1 },
  { name: 'codex tool event', cli: 'codex', fixture: 'codex-tool-event.json', expect: 1 },
];
```

### 완료 기준
- 주요 CLI 분기 fixture 커버
- 파서 변경 시 fixture 테이블에서 즉시 실패 감지

---

## 2-2. Telegram 시나리오 확장

### 목적
- 단순 skip 테스트를 넘어 lifecycle/경합 회귀까지 검증

### 작업
- `initTelegram()` 반복 호출 후 listener 1개 유지 확인
- 긴 메시지 chunk 전송 + HTML fallback 경로 검증
- `origin`이 섞인 동시 요청 시 forward 정책 유지 검증

### 스니펫
```js
test('re-init should not duplicate forwarder listener', async () => {
  // init -> init -> init 이후 broadcast 1회당 sendMessage 1회 보장
});
```

### 완료 기준
- listener 누수/중복 전송 회귀 자동 차단
- 경합 케이스 재현 시 테스트 통과

---

## 2-3. 자동화 루프 정비

### 작업
- `npm test`에 핵심 + 확장 테스트 집계
- `test:watch` 도입(로컬 빠른 피드백)
- 필요 시 pre-push/CI 연동

### 예시
```json
{
  "scripts": {
    "test": "node --test tests/**/*.test.js",
    "test:watch": "node --test --watch tests/**/*.test.js",
    "test:events": "node --test tests/events.test.js",
    "test:telegram": "node --test tests/telegram-forwarding.test.js"
  }
}
```

### 완료 기준
- 로컬 `npm test` 1회로 회귀 검증 가능
- (선택) CI에서 동일 스크립트 자동 실행

---

## 권장 순서
1. `events` fixture 확장
2. `telegram` lifecycle/경합 테스트 확장
3. 테스트 집계 스크립트 + 자동화 훅 적용
