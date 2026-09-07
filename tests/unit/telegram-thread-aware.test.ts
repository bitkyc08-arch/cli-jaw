// P0 — thread-aware Telegram send. Verifies message_thread_id is threaded into
// programmatic sends, that the General topic (id=1) is omitted, and that dedup
// distinguishes forum topics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { threadIdNumber } from '../../src/messaging/thread-target.ts';
import { sendTelegramFile } from '../../src/telegram/telegram-file.ts';
import { dedupKey } from '../../src/orchestrator/gateway.ts';
import { channelGateOn } from '../../src/orchestrator/scope.ts';
import { settings } from '../../src/core/config.ts';

const botSrc = fs.readFileSync(new URL('../../src/telegram/bot.ts', import.meta.url), 'utf8');
const gatewaySrc = fs.readFileSync(new URL('../../src/orchestrator/gateway.ts', import.meta.url), 'utf8');

const tgt = (threadId?: string) =>
    ({ channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100', threadId } as never);

function botSpy() {
    const calls: Array<{ method: string; opts: Record<string, unknown> }> = [];
    const mk = (method: string) => async (_chatId: unknown, _file: unknown, opts: Record<string, unknown>) => {
        calls.push({ method, opts });
    };
    return { calls, api: { sendVoice: mk('sendVoice'), sendPhoto: mk('sendPhoto'), sendDocument: mk('sendDocument') } };
}

test('threadIdNumber: real topic → number; General(1)/0/neg/non-numeric/absent → undefined', () => {
    assert.equal(threadIdNumber(tgt('42')), 42);
    assert.equal(threadIdNumber(tgt('1')), undefined);   // General topic sends as usual
    assert.equal(threadIdNumber(tgt('0')), undefined);
    assert.equal(threadIdNumber(tgt('-3')), undefined);
    assert.equal(threadIdNumber(tgt('abc')), undefined);
    assert.equal(threadIdNumber(tgt('')), undefined);
    assert.equal(threadIdNumber(tgt(undefined)), undefined);
    assert.equal(threadIdNumber(undefined), undefined);
});

test('sendTelegramFile threads message_thread_id when provided', async () => {
    const tmp = path.join(os.tmpdir(), 'p0-thread-voice.bin');
    fs.writeFileSync(tmp, 'x');
    const bot = botSpy();
    const r = await sendTelegramFile(bot as never, '-100', tmp, 'voice', { caption: 'c', threadId: 42 });
    assert.equal(r.ok, true);
    assert.equal(bot.calls[0]?.method, 'sendVoice');
    assert.equal(bot.calls[0]?.opts.message_thread_id, 42);
    assert.equal(bot.calls[0]?.opts.caption, 'c');
});

test('sendTelegramFile omits message_thread_id when absent (byte-identical to today)', async () => {
    const tmp = path.join(os.tmpdir(), 'p0-thread-photo.bin');
    fs.writeFileSync(tmp, 'x');
    const bot = botSpy();
    await sendTelegramFile(bot as never, '-100', tmp, 'photo', { caption: 'c' });
    assert.equal(bot.calls[0]?.method, 'sendPhoto');
    assert.ok(!('message_thread_id' in (bot.calls[0]?.opts ?? {})));   // stripUndefined dropped it
});

test('dedupKey distinguishes forum topics, stable within a topic', () => {
    assert.notEqual(dedupKey('scope-A', 'telegram', 'hi', '-100', '5'), dedupKey('scope-A', 'telegram', 'hi', '-100', '6'));
    assert.equal(dedupKey('scope-A', 'telegram', 'hi', '-100', '5'), dedupKey('scope-A', 'telegram', 'hi', '-100', '5'));
    // no-thread (DM/General) key is stable and distinct from a topic key
    assert.notEqual(dedupKey('scope-A', 'telegram', 'hi', '-100'), dedupKey('scope-A', 'telegram', 'hi', '-100', '5'));
    assert.notEqual(dedupKey('scope-A', 'telegram', 'hi', '-100', '5'), dedupKey('scope-B', 'telegram', 'hi', '-100', '5'));
});

test('buildTelegramTarget uses ctx.msg and only splits real forum topics', () => {
    const fnStart = botSrc.indexOf('function buildTelegramTarget');
    const fnEnd = botSrc.indexOf('async function telegramSendHandler', fnStart);
    assert.ok(fnStart >= 0 && fnEnd > fnStart, 'buildTelegramTarget block should be bounded');
    const block = botSrc.slice(fnStart, fnEnd);
    assert.match(block, /ctx\.msg\?\.is_topic_message/);
    assert.match(block, /messageThreadId\s*>\s*1|ctx\.msg\.message_thread_id\s*>\s*1/);
    assert.match(block, /String\((?:messageThreadId|ctx\.msg\.message_thread_id)\)/);
    assert.ok(!block.includes('ctx.message?.message_thread_id'));
});

test('gateway pins both scope and chatSessionId for gated-off remote channels', () => {
    const start = gatewaySrc.indexOf('const multiSessionEnabled');
    const end = gatewaySrc.indexOf('const sessionScope', start);
    assert.ok(start >= 0 && end > start, 'gateway session-resolution block should be bounded');
    const block = gatewaySrc.slice(start, end);
    assert.ok(block.includes('channelGateOn(meta.target.channel)'), 'gateway should apply the shared channel gate');
    assert.match(block, /const chatSessionId\s*=[\s\S]*?['"]default['"]/);
    assert.match(block, /const scope\s*=[\s\S]*?['"]default['"]/);
});

test('channelGateOn preserves Slack opt-out and Telegram opt-in defaults', () => {
    const previous = settings.multiSession;
    try {
        settings.multiSession = { enabled: true, maxConcurrent: 1, midRunPolicy: 'steer' };
        assert.equal(channelGateOn('telegram'), false, 'Telegram stays gated off unless explicitly true');
        assert.equal(channelGateOn('slack'), true, 'Slack stays on unless explicitly false');

        settings.multiSession.channels = { telegram: true, slack: false };
        assert.equal(channelGateOn('telegram'), true);
        assert.equal(channelGateOn('slack'), false);
    } finally {
        settings.multiSession = previous;
    }
});
