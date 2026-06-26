// P2 — hub bot pure decision helpers. The Bot wiring / inbound routing / sendToTopic
// are integration-verified; here we cover the testable units: General-topic key
// normalization and the start guard (GPT Pro B1: enabled+token+chatId required).
import test from 'node:test';
import assert from 'node:assert/strict';
import { threadKey, canStartHub } from '../../src/manager/telegram-hub/hub-bot.ts';
import type { TelegramHubConfig } from '../../src/manager/telegram-hub/types.ts';

const cfg = (o: Partial<TelegramHubConfig>): TelegramHubConfig =>
    ({ enabled: false, token: '', chatId: '', defaultPort: 3457, routes: [], ...o });

test('threadKey: General (<=1) → "1", real topics pass through', () => {
    assert.equal(threadKey(undefined), '1');
    assert.equal(threadKey(0), '1');
    assert.equal(threadKey(1), '1');
    assert.equal(threadKey(5), '5');
    assert.equal(threadKey(100), '100');
});

test('canStartHub requires enabled + token + chatId (GPT Pro B1: no unbound start)', () => {
    assert.equal(canStartHub(cfg({ enabled: true, token: 't', chatId: '-100' })), true);
    assert.equal(canStartHub(cfg({ enabled: false, token: 't', chatId: '-100' })), false);
    assert.equal(canStartHub(cfg({ enabled: true, token: '', chatId: '-100' })), false);
    assert.equal(canStartHub(cfg({ enabled: true, token: 't', chatId: '' })), false);
});
