// P0 — thread-aware Telegram send. Verifies message_thread_id is threaded into
// programmatic sends, that the General topic (id=1) is omitted, and that dedup
// distinguishes forum topics. See devlog/_fin/260626_telegram_topic_routing_hub/10.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { threadIdNumber } from '../../src/messaging/thread-target.ts';
import { sendTelegramFile } from '../../src/telegram/telegram-file.ts';
import { dedupKey } from '../../src/orchestrator/gateway.ts';

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
