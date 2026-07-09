// P2 — hub bot pure decision helpers. The Bot wiring / inbound routing / sendToTopic
// are integration-verified; here we cover the testable units: General-topic key
// normalization and the start guard (GPT Pro B1: enabled+token+chatId required).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    threadKey,
    canStartHub,
    canMutateHubRoute,
    getHubBotStatus,
    tracePrefix,
    buildLocalFirstSettingsPatch,
    handleHubCommand,
    sendToTopic,
    __topicTypingTest,
} from '../../src/manager/telegram-hub/hub-bot.ts';
import type { TelegramHubConfig } from '../../src/manager/telegram-hub/types.ts';

const cfg = (o: Partial<TelegramHubConfig>): TelegramHubConfig =>
    ({ enabled: false, token: '', chatId: '', defaultPort: 3457, routes: [], ...o });
const hubBotSrc = readFileSync(new URL('../../src/manager/telegram-hub/hub-bot.ts', import.meta.url), 'utf8');

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

test('buildLocalFirstSettingsPatch enables target bot, preserves allowlist, and sets callback', () => {
    const patch = buildLocalFirstSettingsPatch('8231528245', {
        telegram: { enabled: true, allowedChatIds: [111] },
        telegramHub: { mode: 'hub-member' },
    }, 'http://127.0.0.1:24576');
    assert.deepEqual(patch, {
        telegram: { enabled: true, allowedChatIds: [111, 8231528245], forwardAll: true, mentionOnly: true },
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

test('handleHubCommand /setthread does not enable route when hub-member ensure fails', async () => {
    const result = await handleHubCommand(
        'setthread',
        ['3458'],
        '8231528245',
        '10815',
        async () => true,
        async () => ({ ok: false, error: 'settings PUT 503' }),
    );
    assert.equal(result, '⚠️ 인스턴스 3458 hub-member 자동 설정 실패: settings PUT 503\n라우팅은 활성화하지 않았습니다.');
});

test('forwardToInstance surfaces target non-ok responses as sync topic errors', () => {
    const start = hubBotSrc.indexOf('async function forwardToInstance(');
    const end = hubBotSrc.indexOf('// P3: real hub-command handlers', start);
    assert.ok(start >= 0 && end > start, 'forwardToInstance block must exist');
    const block = hubBotSrc.slice(start, end);
    assert.match(block, /!res\.ok\s*\|\|\s*j\['ok'\]\s*===\s*false/);
    assert.match(block, /인스턴스 \$\{port\} 요청 실패/);
});

test('sendToTopic stops topic typing before outbound delivery', () => {
    const sendStart = hubBotSrc.indexOf('export async function sendToTopic(');
    const sendEnd = hubBotSrc.indexOf('/**\n * Start', sendStart);
    assert.ok(sendStart >= 0, 'sendToTopic export must exist');
    assert.ok(sendEnd > sendStart, 'sendToTopic block must be bounded');
    const sendBlock = hubBotSrc.slice(sendStart, sendEnd);
    const stopIdx = sendBlock.indexOf('stopTopicTyping(chatId, threadId);');
    const textSendIdx = sendBlock.indexOf("if (payload.type === 'text')");
    const fileSendIdx = sendBlock.indexOf('sendTelegramFile(');
    assert.ok(stopIdx >= 0, 'sendToTopic must stop typing for the topic');
    assert.ok(textSendIdx > stopIdx, 'typing must stop before text delivery');
    assert.ok(fileSendIdx > stopIdx, 'typing must stop before file delivery');
});

test('sendToTopic clears topic typing state before outbound delivery', async () => {
    __topicTypingTest.start('8231528245', '10815');
    assert.equal(__topicTypingTest.count(), 1);
    const result = await sendToTopic('8231528245', '10815', { type: 'text', text: 'done' });
    assert.deepEqual(result, { ok: false, error: 'hub bot not running' });
    assert.equal(__topicTypingTest.count(), 0);
});

test('stopHubBot clears all topic typing timers', async () => {
    __topicTypingTest.start('8231528245', '10815');
    __topicTypingTest.start('8231528245', '10816');
    assert.equal(__topicTypingTest.count(), 2);
    __topicTypingTest.clearAll();
    assert.equal(__topicTypingTest.count(), 0);
});
