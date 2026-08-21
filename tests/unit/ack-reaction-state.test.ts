import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cloneAckDefaults,
    createAckHandle,
    mergeAckSettings,
    resolveAckConfig,
    resolveAckEmoji,
    shouldAck,
    DISCORD_ACK_DEFAULTS,
    SLACK_ACK_DEFAULTS,
    TELEGRAM_ACK_DEFAULTS,
    type AckReactionConfig,
    type AckTransitionMode,
    type AckTransport,
} from '../../src/messaging/ack-reaction.ts';

const CONFIG: AckReactionConfig = {
    enabled: true,
    scope: 'all',
    emoji: { running: 'eyes', success: 'ok', failure: 'no', queued: 'wait' },
    removeAfterReply: false,
};

/** Records every vendor call so a branch can be proven to have fired — or not. */
function fakeTransport(mode: AckTransitionMode, overrides: Partial<AckTransport> = {}) {
    const calls: string[] = [];
    const transport: AckTransport = {
        mode,
        async apply(emoji) { calls.push(`apply:${emoji}`); },
        async remove(emoji) { calls.push(`remove:${emoji}`); },
        coerce: (emoji) => emoji,
        ...overrides,
    };
    return { transport, calls };
}

test('resolveAckEmoji maps each state, and wasQueued only changes the progress signal', () => {
    assert.equal(resolveAckEmoji(CONFIG, 'received'), 'eyes');
    assert.equal(resolveAckEmoji(CONFIG, 'running'), 'eyes');
    assert.equal(resolveAckEmoji(CONFIG, 'success'), 'ok');
    assert.equal(resolveAckEmoji(CONFIG, 'failure'), 'no');
    // Dynamic selection: same state, different context, different emoji.
    assert.equal(resolveAckEmoji(CONFIG, 'running', { wasQueued: true }), 'wait');
    // A terminal outcome is not a queue state, so wasQueued must not touch it.
    assert.equal(resolveAckEmoji(CONFIG, 'success', { wasQueued: true }), 'ok');
});

test('resolveAckEmoji falls back to running when no queued emoji is configured', () => {
    const noQueued: AckReactionConfig = { ...CONFIG, emoji: { running: 'eyes', success: 'ok', failure: 'no' } };
    assert.equal(resolveAckEmoji(noQueued, 'running', { wasQueued: true }), 'eyes');
});

test('shouldAck gates on scope', () => {
    const at = (scope: AckReactionConfig['scope'], isDirect: boolean, isMention: boolean) =>
        shouldAck({ ...CONFIG, scope }, { isDirect, isMention });
    assert.equal(at('all', false, false), true);
    assert.equal(at('off', true, true), false);
    assert.equal(at('direct', true, false), true);
    assert.equal(at('direct', false, true), false);
    assert.equal(at('group-mentions', false, true), true);
    assert.equal(at('group-mentions', false, false), false);
    assert.equal(at('group-mentions', true, false), true);
    // disabled beats every scope
    assert.equal(shouldAck({ ...CONFIG, enabled: false, scope: 'all' }, { isDirect: true, isMention: true }), false);
});

test('replace transports never issue a remove between states', async () => {
    const { transport, calls } = fakeTransport('replace');
    const handle = createAckHandle(CONFIG, transport);
    await handle.to('running');
    await handle.settle('success');
    assert.deepEqual(calls, ['apply:eyes', 'apply:ok']);
    assert.equal(handle.applied, 'ok');
});

test('remove-then-add transports clear the previous reaction first', async () => {
    const { transport, calls } = fakeTransport('remove-then-add');
    const handle = createAckHandle(CONFIG, transport);
    await handle.to('running');
    await handle.settle('failure');
    assert.deepEqual(calls, ['apply:eyes', 'remove:eyes', 'apply:no']);
});

test('C-5: concurrent settles are serialized and the first outcome wins', async () => {
    const { transport, calls } = fakeTransport('replace');
    const handle = createAckHandle(CONFIG, transport);
    // Deliberately not awaited: a lane runner can start a task synchronously, so
    // the terminal transition can be issued while the running apply is in flight.
    const running = handle.to('running');
    const first = handle.settle('success');
    const second = handle.settle('failure');
    await Promise.all([running, first, second]);
    // running applied, then exactly ONE terminal apply, and it is the first one.
    assert.deepEqual(calls, ['apply:eyes', 'apply:ok']);
    assert.equal(handle.applied, 'ok');
});

test('C-5: a terminal transition issued before running still leaves one outcome', async () => {
    const { transport, calls } = fakeTransport('replace');
    const handle = createAckHandle(CONFIG, transport);
    const settled = handle.settle('success');
    const late = handle.to('running');
    await Promise.all([settled, late]);
    // The late progress transition must NOT overwrite the terminal state.
    assert.deepEqual(calls, ['apply:ok']);
    assert.equal(handle.applied, 'ok');
});

test('a vendor failure is swallowed and does not record the emoji as applied', async () => {
    const errors: unknown[] = [];
    const { transport, calls } = fakeTransport('replace', {
        async apply() { throw new Error('missing_scope'); },
    });
    const handle = createAckHandle(CONFIG, transport, (e) => errors.push(e));
    await handle.to('running');
    assert.equal(handle.applied, null, 'a reaction that never landed must not be recorded');
    assert.equal(errors.length, 1);
    assert.deepEqual(calls, []);
});

test('coerce returning null makes no vendor call at all', async () => {
    const { transport, calls } = fakeTransport('replace', { coerce: () => null });
    const handle = createAckHandle(CONFIG, transport);
    await handle.to('running');
    await handle.settle('success');
    assert.deepEqual(calls, []);
    assert.equal(handle.applied, null);
});

test('removeAfterReply clears the terminal reaction, and only settle owns that', async () => {
    const { transport, calls } = fakeTransport('replace');
    const handle = createAckHandle({ ...CONFIG, removeAfterReply: true }, transport);
    await handle.to('running');
    await handle.settle('success');
    assert.deepEqual(calls, ['apply:eyes', 'apply:ok', 'remove:ok']);
    assert.equal(handle.applied, null);
});

test('resolveAckConfig normalizes hostile input instead of throwing', () => {
    assert.deepEqual(resolveAckConfig(null, SLACK_ACK_DEFAULTS), SLACK_ACK_DEFAULTS);
    assert.deepEqual(resolveAckConfig('nope', SLACK_ACK_DEFAULTS), SLACK_ACK_DEFAULTS);
    assert.deepEqual(resolveAckConfig([1, 2], SLACK_ACK_DEFAULTS), SLACK_ACK_DEFAULTS);
    // An unknown scope falls back rather than reaching a channel as garbage.
    assert.equal(resolveAckConfig({ scope: 'everywhere' }, SLACK_ACK_DEFAULTS).scope, SLACK_ACK_DEFAULTS.scope);
    // Blank emoji strings are not usable values.
    assert.equal(resolveAckConfig({ emoji: { running: '   ' } }, SLACK_ACK_DEFAULTS).emoji.running,
        SLACK_ACK_DEFAULTS.emoji.running);
    assert.equal(resolveAckConfig({ enabled: 'yes' }, SLACK_ACK_DEFAULTS).enabled, false);
    assert.equal(resolveAckConfig({ enabled: true }, SLACK_ACK_DEFAULTS).enabled, true);
});

test('mergeAckSettings keeps siblings a partial patch never mentioned', () => {
    const merged = mergeAckSettings(SLACK_ACK_DEFAULTS, { enabled: true });
    assert.equal(merged['enabled'], true);
    assert.equal(merged['scope'], SLACK_ACK_DEFAULTS.scope);
    assert.deepEqual(merged['emoji'], SLACK_ACK_DEFAULTS.emoji);
    assert.equal(merged['removeAfterReply'], SLACK_ACK_DEFAULTS.removeAfterReply);
});

test('mergeAckSettings merges the emoji group without dropping unlisted states', () => {
    const merged = mergeAckSettings(SLACK_ACK_DEFAULTS, { emoji: { running: 'wave' } });
    const emoji = merged['emoji'] as Record<string, unknown>;
    assert.equal(emoji['running'], 'wave');
    assert.equal(emoji['success'], SLACK_ACK_DEFAULTS.emoji.success);
    assert.equal(emoji['failure'], SLACK_ACK_DEFAULTS.emoji.failure);
});

test('W1-3: cloneAckDefaults isolates the exported constants from mutation', () => {
    const copy = cloneAckDefaults(SLACK_ACK_DEFAULTS) as unknown as Record<string, any>;
    copy['enabled'] = true;
    copy['emoji']['running'] = 'mutated';
    assert.equal(SLACK_ACK_DEFAULTS.enabled, false, 'exported default must not be reachable by mutation');
    assert.equal(SLACK_ACK_DEFAULTS.emoji.running, 'eyes');
    // A second copy must be unaffected by the first one's edits.
    assert.equal(cloneAckDefaults(SLACK_ACK_DEFAULTS).emoji.running, 'eyes');
});

test('per-channel defaults respect their vendor notation', () => {
    // Slack takes NAMES without colons.
    for (const value of Object.values(SLACK_ACK_DEFAULTS.emoji)) {
        assert.ok(!value.includes(':'), `slack emoji "${value}" must not carry colons`);
    }
    // Telegram cannot use white-check-mark or cross-mark: they are absent from
    // its ReactionTypeEmoji allowlist, which is why thumbs are the default pair.
    assert.equal(TELEGRAM_ACK_DEFAULTS.emoji.success, '\u{1F44D}');
    assert.equal(TELEGRAM_ACK_DEFAULTS.emoji.failure, '\u{1F44E}');
    // Discord has no allowlist, so the conventional pair is fine there.
    assert.equal(DISCORD_ACK_DEFAULTS.emoji.success, '\u2705');
    assert.equal(DISCORD_ACK_DEFAULTS.emoji.failure, '\u274C');
    // Every channel ships disabled.
    for (const d of [SLACK_ACK_DEFAULTS, TELEGRAM_ACK_DEFAULTS, DISCORD_ACK_DEFAULTS]) {
        assert.equal(d.enabled, false);
    }
});

