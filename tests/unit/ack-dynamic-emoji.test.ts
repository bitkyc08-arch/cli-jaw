// Dynamic ACK emoji selection, across the four dimensions the goal names:
// configuration, result state, queue context, and channel constraint.
//
// Each dimension is tested independently on purpose. Testing only context and
// state would stay green if the configured values were ignored in favour of
// per-state constants — which is exactly 'a constant moved into config', not
// dynamic selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveAckEmoji,
    type AckReactionConfig,
} from '../../src/messaging/ack-reaction.ts';
import { coerceTelegramReaction } from '../../src/telegram/reactions.ts';
import { createDiscordAckTransport } from '../../src/discord/reactions.ts';
import type { Message } from 'discord.js';

const CONFIG: AckReactionConfig = {
    enabled: true,
    scope: 'all',
    emoji: { running: 'eyes', success: 'ok', failure: 'no', queued: 'wait' },
    removeAfterReply: false,
};

test('dimension 1 — queue context changes the progress signal', () => {
    assert.equal(resolveAckEmoji(CONFIG, 'running', { wasQueued: false }), 'eyes');
    assert.equal(resolveAckEmoji(CONFIG, 'running', { wasQueued: true }), 'wait');
});

test('dimension 2 — all eight AckState x wasQueued combinations', () => {
    const at = (state: 'received' | 'running' | 'success' | 'failure', wasQueued: boolean) =>
        resolveAckEmoji(CONFIG, state, { wasQueued });
    // received and running share a signal: for the user, picked up and being
    // worked on are the same moment.
    assert.equal(at('received', false), 'eyes');
    assert.equal(at('running', false), 'eyes');
    assert.equal(at('success', false), 'ok');
    assert.equal(at('failure', false), 'no');
    // Terminal states deliberately IGNORE wasQueued — a finished turn is not a
    // waiting one, however it got there.
    assert.equal(at('success', true), 'ok');
    assert.equal(at('failure', true), 'no');
    assert.equal(at('received', true), 'wait');
    assert.equal(at('running', true), 'wait');
});

test('dimension 3 — different configured values change the output', () => {
    // The dimension that catches hardcoded per-state constants.
    const other: AckReactionConfig = {
        ...CONFIG,
        emoji: { running: 'hourglass', success: 'tada', failure: 'boom', queued: 'zzz' },
    };
    assert.equal(resolveAckEmoji(other, 'running', {}), 'hourglass');
    assert.equal(resolveAckEmoji(other, 'success', {}), 'tada');
    assert.equal(resolveAckEmoji(other, 'failure', {}), 'boom');
    assert.equal(resolveAckEmoji(other, 'running', { wasQueued: true }), 'zzz');
    // And the original config is unaffected — no shared mutable state.
    assert.equal(resolveAckEmoji(CONFIG, 'running', {}), 'eyes');
});

test('dimension 4 — the same emoji renders differently per channel constraint', () => {
    // This is the case that only becomes testable once all three channels exist.
    // One config, two channels, two different results — because Telegram's
    // ReactionTypeEmoji allowlist has no hourglass and Discord has no allowlist.
    const shared: AckReactionConfig = {
        ...CONFIG,
        emoji: { running: '⏳', success: '👍', failure: '👎' },
    };
    const wanted = resolveAckEmoji(shared, 'running', {});
    assert.equal(wanted, '⏳');

    const discord = createDiscordAckTransport({} as unknown as Message);
    assert.equal(discord.coerce(wanted!), '⏳', 'Discord renders it as configured');
    assert.equal(coerceTelegramReaction(wanted!), '👀', 'Telegram must fall back');

    // A value both channels accept passes through identically, so the divergence
    // above is the constraint talking, not a blanket rewrite.
    assert.equal(coerceTelegramReaction('👍'), '👍');
    assert.equal(discord.coerce('👍'), '👍');
});

test('a config with no queued emoji falls back rather than blanking', () => {
    const noQueued: AckReactionConfig = {
        ...CONFIG,
        emoji: { running: 'eyes', success: 'ok', failure: 'no' },
    };
    assert.equal(resolveAckEmoji(noQueued, 'running', { wasQueued: true }), 'eyes');
});
