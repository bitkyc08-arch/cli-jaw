// P1 — telegramHub registry normalization. Verifies the data layer: safe defaults,
// route key-preservation (audit blocker #2), port-range validation, defaultPort clamp.
// normalizeTelegramHub is the single funnel for default / normalize / patch, so testing
// it covers the file round-trip path. See devlog/_plan/260626_telegram_topic_routing_hub/20.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTelegramHub } from '../../src/manager/registry.ts';

test('normalizeTelegramHub(undefined) → safe defaults (migration safety)', () => {
    assert.deepEqual(normalizeTelegramHub(undefined), {
        enabled: false, token: '', chatId: '', defaultPort: 3457, routes: [],
    });
});

test('normalizeTelegramHub preserves a fully-specified route (zero key loss)', () => {
    const c = normalizeTelegramHub({
        enabled: true, token: 't', chatId: '-100', defaultPort: 3460,
        routes: [{ chatId: '-100', threadId: '5', port: 3458, label: 'work', enabled: true, systemPrompt: 'sp', model: 'm' }],
    });
    assert.equal(c.enabled, true);
    assert.equal(c.token, 't');
    assert.equal(c.chatId, '-100');
    assert.equal(c.defaultPort, 3460);
    assert.deepEqual(c.routes, [
        { chatId: '-100', threadId: '5', port: 3458, label: 'work', enabled: true, systemPrompt: 'sp', model: 'm' },
    ]);
});

test('normalizeTelegramHub drops out-of-range / malformed routes', () => {
    const c = normalizeTelegramHub({
        routes: [
            { chatId: '-100', threadId: '5', port: 3600 },   // > 3506 → drop
            { chatId: '-100', threadId: '6', port: 3000 },   // < 3457 → drop
            { chatId: '', threadId: '7', port: 3458 },       // empty chatId → drop
            { threadId: '8', port: 3458 },                   // missing chatId → drop
            { chatId: '-100', threadId: '9', port: 3458 },   // valid
        ],
    });
    assert.equal(c.routes.length, 1);
    assert.equal(c.routes[0]?.threadId, '9');
    assert.equal(c.routes[0]?.enabled, true);   // enabled defaults to true
});

test('normalizeTelegramHub clamps invalid defaultPort to range start', () => {
    assert.equal(normalizeTelegramHub({ defaultPort: 9999 }).defaultPort, 3457);
    assert.equal(normalizeTelegramHub({ defaultPort: 3470 }).defaultPort, 3470);
});

test('route enabled:false is preserved (so resolveRoute can skip it)', () => {
    const c = normalizeTelegramHub({ routes: [{ chatId: '-100', threadId: '5', port: 3458, enabled: false }] });
    assert.equal(c.routes[0]?.enabled, false);
});
