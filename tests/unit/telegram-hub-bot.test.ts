// P2 — hub bot pure decision helpers. The Bot wiring / inbound routing / sendToTopic
// are integration-verified; here we cover the testable units: General-topic key
// normalization and the start guard (GPT Pro B1: enabled+token+chatId required).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    threadKey,
    canStartHub,
    canMutateHubRoute,
    getHubBotStatus,
    tracePrefix,
    buildHubMemberSettingsPatch,
    handleHubCommand,
    sendToTopic,
    __topicTypingTest,
} from '../../src/manager/telegram-hub/hub-bot.ts';
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

test('getHubBotStatus starts as stopped without network side effects', () => {
    assert.deepEqual(getHubBotStatus(), { state: 'stopped' });
});

test('tracePrefix normalizes whitespace and bounds private text exposure', () => {
    const traced = tracePrefix('  /setthread   3458  '.repeat(10));
    assert.equal(traced.length, 80);
    assert.equal(traced.startsWith('/setthread 3458 /setthread'), true);
    assert.equal(traced.includes('  '), false);
});

test('canStartHub requires enabled + token + chatId (GPT Pro B1: no unbound start)', () => {
    assert.equal(canStartHub(cfg({ enabled: true, token: 't', chatId: '-100' })), true);
    assert.equal(canStartHub(cfg({ enabled: true, token: 't', chatId: '8231528245' })), true);
    assert.equal(canStartHub(cfg({ enabled: false, token: 't', chatId: '-100' })), false);
    assert.equal(canStartHub(cfg({ enabled: true, token: '', chatId: '-100' })), false);
    assert.equal(canStartHub(cfg({ enabled: true, token: 't', chatId: '' })), false);
});

test('canMutateHubRoute allows private chats and preserves group admin gating', () => {
    assert.equal(canMutateHubRoute('private', false), true);
    assert.equal(canMutateHubRoute('private', true), true);
    assert.equal(canMutateHubRoute('group', false), false);
    assert.equal(canMutateHubRoute('group', true), true);
    assert.equal(canMutateHubRoute('supergroup', false), false);
    assert.equal(canMutateHubRoute('supergroup', true), true);
});

test('buildHubMemberSettingsPatch disables target bot, preserves allowlist, and sets callback', () => {
    const patch = buildHubMemberSettingsPatch('8231528245', {
        telegram: { enabled: true, allowedChatIds: [111] },
        telegramHub: { mode: 'standalone' },
    }, 'http://127.0.0.1:24576');
    assert.deepEqual(patch, {
        telegram: { enabled: false, allowedChatIds: [111, 8231528245] },
        telegramHub: { mode: 'hub-member', hubCallbackUrl: 'http://127.0.0.1:24576' },
    });
});

test('handleHubCommand /setthread invokes target hub-member ensure hook', async () => {
    const calls: Array<{ port: number; chatId: string }> = [];
    const result = await handleHubCommand(
        'setthread',
        ['3458'],
        '8231528245',
        '10815',
        async () => true,
        async (port, chatId) => {
            calls.push({ port, chatId });
            return { ok: true };
        },
    );
    assert.equal(result, '✅ 이 토픽 → 인스턴스 3458 연결됨.');
    assert.deepEqual(calls, [{ port: 3458, chatId: '8231528245' }]);
});

test('sendToTopic clears topic typing state before outbound delivery', async () => {
    __topicTypingTest.start('8231528245', '10815');
    assert.equal(__topicTypingTest.count(), 1);
    const result = await sendToTopic('8231528245', '10815', { type: 'text', text: 'done' });
    assert.deepEqual(result, { ok: false, error: 'hub bot not running' });
    assert.equal(__topicTypingTest.count(), 0);
});
