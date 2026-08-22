// ACK wiring at the call sites, not just in the state machine.
//
// The state-machine tests pass whether or not a channel actually CALLS it. Two
// real bugs got through that gap: Telegram built an ACK handle and then used it
// only inside the queued branch, so the common idle path never reacted at all;
// and Slack/Discord settled the outcome only AFTER an uncancellable image
// upload, which can strand the reaction on `running` while the answer is
// already visible. Source-level assertions because the wiring lives inside
// closures that cannot be imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

test('every channel ACKs on its normal path, not only when queued', () => {
    // Slack's normal path is the runReply callback, which appears BEFORE the
    // queued branch; Telegram and Discord put theirs after it. So each channel
    // names the marker that opens its own normal path.
    const cases = [
        { channel: 'slack', file: 'src/slack/bot.ts', handle: 'ack', marker: 'runReply: async (ctx: SlackRunContext)' },
        { channel: 'telegram', file: 'src/telegram/bot.ts', handle: 'ackHandle', marker: 'markChatActive(chat.id, ctx)' },
        { channel: 'discord', file: 'src/discord/bot.ts', handle: 'ack', marker: 'markChannelActive(msg.channelId)' },
    ];
    for (const { channel, file, handle, marker } of cases) {
        const src = read(file);
        const idx = src.indexOf(marker);
        assert.ok(idx > 0, `${channel}: normal-path marker not found`);
        const settleIdx = src.indexOf(`${handle}?.settle(`, idx);
        assert.ok(settleIdx > idx,
            `${channel}: the normal path must settle its ACK, not just the queued path`);
    }
});

test('the ACK outcome is settled before the uncancellable image relay', () => {
    // The answer is already visible once the text lands, so the reaction must not
    // wait on the upload behind it. That was originally because the upload could
    // not be cancelled at all; it is cancellable now (#417), but the ordering
    // still matters — a slow upload would otherwise strand the reaction on
    // `running` long after the user has their answer.
    //
    // Matched by ANCHOR rather than by a literal call string. The previous version
    // pinned the exact argument list, so adding a signal argument broke it without
    // any behaviour changing — a false red that says nothing about ordering.
    const cases = [
        { channel: 'slack', file: 'src/slack/bot.ts', relay: 'relaySlackImages(' },
        { channel: 'discord', file: 'src/discord/bot.ts', relay: 'relayDiscordImages(' },
    ];
    for (const { channel, file, relay } of cases) {
        const src = read(file);
        const settleIdx = src.indexOf('await ack?.settle(ackOutcome);');
        assert.ok(settleIdx > 0, `${channel}: settle call not found`);
        // The NEAREST relay on either side, not the next one anywhere in the file.
        //
        // Scanning only forward made this test unfalsifiable: moving the settle
        // AFTER its own relay still found a later relay belonging to the queued
        // path, so the assertion passed while the invariant was broken. Verified
        // by mutation — swapping the two now turns this red.
        const before = src.lastIndexOf(relay, settleIdx);
        const after = src.indexOf(relay, settleIdx);
        assert.ok(after > 0, `${channel}: no relay call found after the settle`);
        const nearestBefore = before > 0 ? settleIdx - before : Number.POSITIVE_INFINITY;
        assert.ok(after - settleIdx < nearestBefore,
            `${channel}: ACK must settle before its own image relay, not after`);
    }
});

test('Telegram records its outcome before the fire-and-forget relay', () => {
    // Telegram relays with void rather than await, so ordering is about when the
    // outcome is recorded rather than a blocking call.
    const src = read('src/telegram/bot.ts');
    const outcomeIdx = src.indexOf("ackOutcome = 'success'");
    const relayIdx = src.indexOf('void relayTelegramImages(bot, chat.id, collectedText');
    assert.ok(outcomeIdx > 0 && relayIdx > 0);
    assert.ok(outcomeIdx < relayIdx, 'the outcome must be recorded before the relay');
});

test('Slack and Discord settle exactly once per turn', () => {
    // Settling in both the happy path and the finally would double-settle; the
    // guard flag is what keeps it to one.
    for (const file of ['src/slack/bot.ts', 'src/discord/bot.ts']) {
        const src = read(file);
        assert.match(src, /ackSettled = true/, `${file}: needs a settled guard`);
        assert.match(src, /if \(!ackSettled\) await ack\?\.settle/,
            `${file}: the finally must respect the guard`);
    }
});
