import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSendTransport, sendChannelOutput, clampCaptionForChannel } from '../../src/messaging/send.ts';
import { settings } from '../../src/core/config.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

// #517 promotes an agent's written answer into the caption field so a file send
// stops arriving as an empty message. An answer is arbitrarily long and the
// caption field is not: Telegram refuses over 1024 with a 400 that
// `isTransient` (src/telegram/telegram-file.ts) correctly does not retry, and
// Discord's `content` refuses over 2000. Unclamped, the fix for an empty
// message would turn a working bare attachment into a hard failure — a worse
// outcome than the defect it repairs. These tests drive those ceilings.

function targetFor(channel: 'slack' | 'telegram' | 'discord'): RemoteTarget {
    return {
        channel,
        targetKind: 'channel',
        peerKind: 'channel',
        targetId: channel === 'slack' ? 'C_CLAMP_TEST' : '99887766',
    };
}

function allowSlack(id: string): void {
    settings['slack'] = { ...(settings['slack'] || {}), channelIds: [id] };
}

/** Telegram enforces its own allowlist before a send is dispatched, so a target
 *  that is not configured is refused and never reaches the transport — the test
 *  would then pass for the wrong reason. */
function allowTelegram(id: string): void {
    settings['telegram'] = { ...(settings['telegram'] || {}), allowedChatIds: [id] };
}

test('CAP-001: the clamp is a no-op below every channel ceiling', () => {
    const short = 'a short answer';
    for (const channel of ['slack', 'telegram', 'discord'] as const) {
        assert.equal(clampCaptionForChannel(short, channel), short);
    }
});

test('CAP-002: Telegram is cut at 1024, the length its API refuses beyond', () => {
    const long = 'ㄱ'.repeat(5000);
    const out = clampCaptionForChannel(long, 'telegram');
    assert.equal([...out].length, 1024, 'a caption over 1024 is a non-transient 400, not a retry');
    assert.ok(out.endsWith('…'), 'the truncation must be visible to the reader');
});

test('CAP-003: Discord is cut at 2000, the content ceiling', () => {
    const long = 'x'.repeat(5000);
    const out = clampCaptionForChannel(long, 'discord');
    assert.equal([...out].length, 2000, 'over 2000 Discord answers BASE_TYPE_MAX_LENGTH');
});

test('CAP-004: Slack keeps far more, because it truncates rather than refusing', () => {
    const long = 'x'.repeat(50_000);
    const out = clampCaptionForChannel(long, 'slack');
    assert.equal([...out].length, 40_000, 'initial_comment is message text, bounded by the message limit');
});

test('CAP-005: clamping counts code points, so a surrogate pair is never split', () => {
    // A Korean or emoji-heavy answer is exactly what pushes a caption over the
    // line, and slicing by UTF-16 unit would leave a broken half-character.
    const emoji = '😀'.repeat(3000);
    const out = clampCaptionForChannel(emoji, 'telegram');
    assert.equal([...out].length, 1024);
    assert.ok(!/[\uD800-\uDBFF]$/.test(out.slice(0, -1)), 'no dangling high surrogate');
});

test('CAP-006: a long promoted answer reaches Telegram already clamped', async () => {
    // The activation case: without the clamp at the promotion site this send is
    // rejected outright and the user loses both the answer AND the file.
    const target = targetFor('telegram');
    allowTelegram(target.targetId);
    const sent: Record<string, unknown>[] = [];
    registerSendTransport('telegram', async (req) => { sent.push(req as Record<string, unknown>); return { ok: true }; });

    await sendChannelOutput({
        channel: 'telegram',
        type: 'photo',
        filePath: '/tmp/never-read-by-this-test.png',
        text: 'ㄱ'.repeat(4000),
        target,
        fromAgentSurface: true,
    });

    const caption = sent[0]?.['caption'];
    assert.equal(typeof caption, 'string');
    assert.equal([...(caption as string)].length, 1024, 'the transport must never see a caption it will refuse');
});

test('CAP-007: Slack receives the whole answer, not a Telegram-sized one', async () => {
    const id = 'C_CLAMP_TEST';
    allowSlack(id);
    const sent: Record<string, unknown>[] = [];
    registerSendTransport('slack', async (req) => { sent.push(req as Record<string, unknown>); return { ok: true }; });

    const answer = 'ㄱ'.repeat(4000);
    await sendChannelOutput({
        channel: 'slack',
        type: 'document',
        filePath: '/tmp/never-read-by-this-test.pdf',
        text: answer,
        target: targetFor('slack'),
        fromAgentSurface: true,
    });

    assert.equal(sent[0]?.['caption'], answer, 'clamping to the strictest channel would truncate Slack for no reason');
});
