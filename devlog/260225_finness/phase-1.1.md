# Phase 1.1 (P1): 최소 회귀 테스트 상향 (0.5~1일)

## 배경
- 기존 문서에서 테스트가 P2로 밀려 있었음
- 최근 회귀 패턴(`events.js`/`telegram.js` hotfix 연쇄) 기준으로 최소 테스트 2개는 P1에서 먼저 고정해야 함

## 목표
- 이벤트 회귀 최소 테스트 1세트
- Telegram 포워딩 회귀 최소 테스트 1세트
- 실행 스크립트 고정(`test:events`, `test:telegram`)

## 구현 반영 결과 (2026-02-24)
- [x] `tests/events.test.js` 추가 (dedupe/fallback/stream-after-assistant 차단)
- [x] `tests/telegram-forwarding.test.js` 추가 (telegram-origin skip, error skip, HTML fallback)
- [x] `tests/fixtures/claude-stream-tool.json`, `tests/fixtures/claude-assistant-tool.json` 추가
- [x] `src/events.js`에 테스트용 export 추가 (`extractToolLabelsForTest`)
- [x] `src/telegram-forwarder.js` 신설 및 `src/telegram.js` forwarder 로직 분리
- [x] `package.json` scripts: `test`, `test:watch`, `test:events`, `test:telegram`

### 실행 검증
```bash
cd ~/Documents/BlogProject/cli-claw
npm run test:events
npm run test:telegram
npm test
```

## 범위
- `tests/events.test.js`
- `tests/telegram-forwarding.test.js`
- `tests/fixtures/*` (최소 fixture)
- `package.json`

---

## 1. 이벤트 최소 테스트 (`tests/events.test.js`)

### 필수 케이스 (최소 3)
1. `stream_event` tool 라벨 dedupe
2. `assistant` fallback 동작(스트림 미수신 환경)
3. `stream_event` 수신 후 `assistant` tool block 무시

### 스니펫
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToolLabelsForTest } from '../src/events.js';

test('stream_event dedupe', () => {
  const ctx = { seenToolKeys: new Set(), hasClaudeStreamEvents: false };
  const evt = {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Bash' } },
  };
  assert.equal(extractToolLabelsForTest('claude', evt, ctx).length, 1);
  assert.equal(extractToolLabelsForTest('claude', evt, ctx).length, 0);
});
```

---

## 2. Telegram 최소 테스트 (`tests/telegram-forwarding.test.js`)

### 필수 케이스 (최소 2)
1. `origin === 'telegram'` 응답은 forward skip
2. `error === true` 응답은 forward skip

### 스니펫
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramForwarder } from '../src/telegram.js';

test('skip telegram-origin', async () => {
  const sent = [];
  const bot = { api: { sendMessage: async (...args) => sent.push(args) } };
  const forward = createTelegramForwarder({
    bot,
    getLastChatId: () => 123,
    shouldSkip: (data) => data.origin === 'telegram',
  });
  forward('agent_done', { text: 'A', origin: 'telegram' });
  forward('agent_done', { text: 'B', origin: 'web' });
  assert.equal(sent.length, 1);
});
```

---

## 3. 실행 스크립트

```json
{
  "scripts": {
    "test:events": "node --test tests/events.test.js",
    "test:telegram": "node --test tests/telegram-forwarding.test.js"
  }
}
```

## 완료 기준
- `npm run test:events` 통과
- `npm run test:telegram` 통과
- 두 테스트가 P1 개발 루프에 포함됨
