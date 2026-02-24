# Phase 2 (P2): 회귀 방지 자동화 구현 계획 (2~3일)

## 목표
- 이벤트/텔레그램 회귀를 테스트로 차단
- 최소 테스트 체계를 패키지 스크립트에 통합

## 범위
- `src/events.js` (테스트 가능한 pure helper export)
- `src/telegram.js` (forwarder 로직 분리)
- `tests/events.test.js`
- `tests/telegram-forwarding.test.js`
- `tests/fixtures/*`
- `package.json`

---

## 2-1. 이벤트 파서 단위 테스트

### 핵심 아이디어
- 부작용(`broadcast`)과 분리된 pure function을 테스트
- Claude/Codex/Gemini/OpenCode fixture 기반 회귀 케이스 고정

### 코드 스니펫 (events.js export 분리)
```js
// 기존 private helper를 테스트 가능하게 export
export function extractToolLabelsForTest(cli, event, ctx = {}) {
    return extractToolLabels(cli, event, ctx);
}

export function makeToolDedupeKeyForTest(cli, event, label) {
    return makeToolDedupeKey(cli, event, label);
}
```

### 코드 스니펫 (tests/events.test.js)
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToolLabelsForTest } from '../src/events.js';

test('claude stream_event should emit tool_use once', () => {
    const ctx = { seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    const evt = {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' }, index: 3 },
    };
    const first = extractToolLabelsForTest('claude', evt, ctx);
    const second = extractToolLabelsForTest('claude', evt, ctx);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0); // dedupe 검증
});

test('claude assistant fallback should work when no stream seen', () => {
    const ctx = { seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    const evt = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read' }] },
    };
    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.deepEqual(labels, [{ icon: '🔧', label: 'Read' }]);
});
```

### fixture 샘플 (`tests/fixtures/claude-stream-event.json`)
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 1,
    "content_block": { "type": "tool_use", "name": "Bash" }
  }
}
```

### 완료 기준
- 중복/누락 핵심 케이스를 자동 테스트로 재현 가능
- 이벤트 파서 변경 시 테스트가 회귀를 즉시 감지

---

## 2-2. Telegram 포워딩 통합 테스트 (mock bus)

### 핵심 아이디어
- `telegram.js`의 포워딩 판단/전송 루틴을 별도 팩토리 함수로 분리
- mock `bot.api.sendMessage`와 mock bus로 검증

### 코드 스니펫 (telegram.js)
```js
export function createTelegramForwarder({ bot, getLastChatId, shouldSkip }) {
    return (type, data) => {
        if (type !== 'agent_done' || !data?.text || data.error) return;
        if (shouldSkip?.(data)) return;
        const chatId = getLastChatId();
        if (!chatId) return;

        const html = markdownToTelegramHtml(data.text);
        for (const chunk of chunkTelegramMessage(html)) {
            bot.api.sendMessage(chatId, `📡 ${chunk}`, { parse_mode: 'HTML' })
                .catch(() => bot.api.sendMessage(chatId, `📡 ${chunk.replace(/<[^>]+>/g, '')}`));
        }
    };
}
```

### 코드 스니펫 (tests/telegram-forwarding.test.js)
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramForwarder } from '../src/telegram.js';

test('forwarder should skip telegram-origin responses', async () => {
    const sent = [];
    const bot = { api: { sendMessage: async (...args) => { sent.push(args); } } };
    const handler = createTelegramForwarder({
        bot,
        getLastChatId: () => 123,
        shouldSkip: (data) => data.origin === 'telegram',
    });

    handler('agent_done', { text: 'A', origin: 'telegram' });
    handler('agent_done', { text: 'B', origin: 'web' });

    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 123);
});
```

### 완료 기준
- Telegram 기원 응답 스킵/비텔레그램 포워딩이 자동으로 검증됨
- 재초기화 시 listener 중복 방지 로직 테스트 통과

---

## 2-3. 테스트 실행 스크립트 정비

### 코드 스니펫 (package.json)
```json
{
  "scripts": {
    "dev": "node --env-file=.env --dns-result-order=ipv4first server.js",
    "postinstall": "node bin/postinstall.js",
    "test": "node --test tests/**/*.test.js",
    "test:watch": "node --test --watch tests/**/*.test.js",
    "test:events": "node --test tests/events.test.js",
    "test:telegram": "node --test tests/telegram-forwarding.test.js"
  }
}
```

### 로컬 실행 순서
```bash
npm run test:events
npm run test:telegram
npm test
```

### 완료 기준
- 최소 2개 핵심 테스트(events, telegram)가 기본 테스트에 포함
- 수정 후 PR 전 `npm test` 1회로 회귀 체크 가능

---

## 단계별 도입 순서 (권장)
1. `events.js` pure helper export + `events.test.js` 먼저 작성
2. `telegram.js` forwarder 팩토리 분리 + `telegram-forwarding.test.js` 작성
3. `package.json` test scripts 추가, CI/로컬 공통 명령 고정

---

## 권장 커밋 단위
1. `[test] events parser regression tests`
2. `[test] telegram forwarding behavior tests`
3. `[chore] package scripts for node test runner`
