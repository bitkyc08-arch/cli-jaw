import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRemoteBindingKey } from '../../src/messaging/session-key.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';
import { threadKey } from '../../src/manager/telegram-hub/hub-bot.ts';
import { readSource } from './source-normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const botSrc = readSource(join(__dirname, '../../src/telegram/bot.ts'), 'utf8');

const telegramTarget = (threadId?: string): RemoteTarget => ({
    channel: 'telegram',
    targetKind: 'channel',
    peerKind: 'group',
    targetId: '-100123',
    ...(threadId ? { threadId } : {}),
});

test('Telegram General-topic bot and hub targets share the unsuffixed binding key', () => {
    const expected = 'jaw:telegram:group:-100123';
    assert.equal(buildRemoteBindingKey(telegramTarget()), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget(threadKey(1))), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget('0')), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget('-3')), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget(threadKey(undefined))), expected);
});

test('Telegram forum-topic bot and hub targets share the same threaded binding key', () => {
    const expected = 'jaw:telegram:group:-100123:thread:42';
    assert.equal(buildRemoteBindingKey(telegramTarget('42')), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget(threadKey(42))), expected);
});

test('callback-query Telegram targets use ctx.msg topic metadata', () => {
    const fnStart = botSrc.indexOf('function buildTelegramTarget');
    const fnEnd = botSrc.indexOf('async function telegramSendHandler', fnStart);
    assert.ok(fnStart >= 0 && fnEnd > fnStart, 'buildTelegramTarget block should be bounded');
    const block = botSrc.slice(fnStart, fnEnd);
    assert.match(block, /ctx\.msg\?\.is_topic_message/, 'callback-query ctx should resolve through ctx.msg');
    assert.match(block, /messageThreadId\s*>\s*1|ctx\.msg\.message_thread_id\s*>\s*1/, 'General and non-topic threads should normalize away');
    assert.match(block, /String\((?:messageThreadId|ctx\.msg\.message_thread_id)\)/, 'real callback-query topics should retain their id');
    assert.ok(!block.includes('ctx.message?.message_thread_id'), 'ctx.message must not split callback-query targets');
});

test('Telegram normalization does not alter Slack or Discord thread keys', () => {
    const slack: RemoteTarget = {
        channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1', threadId: '171.2',
    };
    const discord: RemoteTarget = {
        channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: '123', threadId: '123',
    };
    assert.equal(buildRemoteBindingKey(slack), 'jaw:slack:channel:C1:thread:171.2');
    assert.equal(buildRemoteBindingKey(discord), 'jaw:discord:channel:123:thread:123');
});
