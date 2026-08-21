import test from 'node:test';
import assert from 'node:assert/strict';
import {
    coerceTelegramReaction,
    isTelegramReactionEmoji,
    createTelegramAckTransport,
    setTelegramReaction,
    TELEGRAM_REACTION_EMOJI,
    type TelegramReactionApi,
} from '../../src/telegram/reactions.ts';
import { createAckHandle, TELEGRAM_ACK_DEFAULTS } from '../../src/messaging/ack-reaction.ts';

function fakeApi() {
    const calls: Record<string, unknown>[] = [];
    const api: TelegramReactionApi = {
        raw: { async setMessageReaction(args, _signal) { calls.push(args); return true; } },
    };
    return { api, calls };
}

test('setMessageReaction sends exactly one ReactionTypeEmoji entry', async () => {
    const { api, calls } = fakeApi();
    await setTelegramReaction(api, -100999, 42, '\u{1F440}');
    assert.deepEqual(calls[0], {
        chat_id: -100999,
        message_id: 42,
        reaction: [{ type: 'emoji', emoji: '\u{1F440}' }],
    });
    // Non-premium bots may set ONE reaction per message.
    assert.equal((calls[0]!['reaction'] as unknown[]).length, 1);
});

test('a null emoji clears with an empty array', async () => {
    const { api, calls } = fakeApi();
    await setTelegramReaction(api, 1, 2, null);
    assert.deepEqual(calls[0]!['reaction'], []);
});

test('the allowlist matches the published ReactionTypeEmoji set', () => {
    // Verbatim from core.telegram.org/bots/api#reactiontypeemoji (2026-08-21),
    // independently re-checked by the plan reviewer. Encoding these as escapes
    // in the source makes them unreadable, so the literal list lives here.
    const published = ['❤','👍','👎','🔥','🥰','👏','😁','🤔','🤯','😱','🤬','😢','🎉',
        '🤩','🤮','💩','🙏','👌','🕊','🤡','🥱','🥴','😍','🐳','❤‍🔥','🌚','🌭','💯',
        '🤣','⚡','🍌','🏆','💔','🤨','😐','🍓','🍾','💋','🖕','😈','😴','😭','🤓',
        '👻','👨‍💻','👀','🎃','🙈','😇','😨','🤝','✍','🤗','🫡','🎅','🎄','☃','💅',
        '🤪','🗿','🆒','💘','🙉','🦄','😘','💊','🙊','😎','👾','🤷‍♂','🤷','🤷‍♀','😡'];
    assert.equal(TELEGRAM_REACTION_EMOJI.size, published.length);
    const missing = published.filter(e => !TELEGRAM_REACTION_EMOJI.has(e));
    assert.deepEqual(missing, [], 'allowlist is missing published emoji');
});

test('the conventional check and cross marks are NOT usable here', () => {
    // The reason Telegram's defaults are thumbs while Discord's are check/cross.
    assert.equal(isTelegramReactionEmoji('✅'), false);
    assert.equal(isTelegramReactionEmoji('❌'), false);
    assert.equal(isTelegramReactionEmoji('⏳'), false);
});

test('every Telegram ack default is inside the allowlist', () => {
    // A default outside the list would fail at the API on the first real turn.
    for (const [state, emoji] of Object.entries(TELEGRAM_ACK_DEFAULTS.emoji)) {
        assert.ok(isTelegramReactionEmoji(emoji), `${state} default ${emoji} is not allowed`);
    }
});

test('an unlisted emoji falls back instead of reaching the API', () => {
    assert.equal(coerceTelegramReaction('🚀'), '👀');
    assert.equal(coerceTelegramReaction('👍'), '👍');
});

test('coerce returns null when even the fallback is unusable', () => {
    // Better to skip the reaction than to send something the API will reject.
    assert.equal(coerceTelegramReaction('🚀', '🚀'), null);
});

// ─── Through the ACK transport seam ──────────────────
// The tests above prove the helper in isolation, which is not the same as
// proving the wiring. These drive createTelegramAckTransport — the SAME factory
// bot.ts uses — so a wiring that picked remove-then-add or dropped the allowlist
// coercion would fail here rather than sliding through.

test('a configured emoji outside the allowlist never reaches the API', async () => {
    const { api, calls } = fakeApi();
    const handle = createAckHandle(
        { ...TELEGRAM_ACK_DEFAULTS, enabled: true, emoji: { running: '🚀', success: '🚀', failure: '🚀' } },
        createTelegramAckTransport(api, 1, 2),
    );
    await handle.to('running');
    // Coerced to the fallback rather than rejected: a settings typo should cost
    // expressiveness, not the acknowledgement.
    const first = calls[0]!['reaction'] as { emoji: string }[];
    assert.equal(first[0]!.emoji, '👀');
});

test('replace semantics: running to success is two calls with no clear between', async () => {
    const { api, calls } = fakeApi();
    const handle = createAckHandle(
        { ...TELEGRAM_ACK_DEFAULTS, enabled: true },
        createTelegramAckTransport(api, 1, 2),
    );
    await handle.to('running');
    await handle.settle('success');
    assert.equal(calls.length, 2, 'a clear between states would make this three');
    const emojis = calls.map(c => (c['reaction'] as { emoji: string }[])[0]!.emoji);
    assert.deepEqual(emojis, ['👀', '👍']);
    // No call ever sends an empty array during a transition.
    assert.equal(calls.some(c => (c['reaction'] as unknown[]).length === 0), false);
});

test('a rejecting API leaves the handle unchanged and reports the error', async () => {
    const errors: unknown[] = [];
    const api: TelegramReactionApi = {
        raw: { async setMessageReaction() { throw new Error('CHAT_NOT_FOUND'); } },
    };
    const handle = createAckHandle(
        { ...TELEGRAM_ACK_DEFAULTS, enabled: true },
        createTelegramAckTransport(api, 1, 2),
        (e) => errors.push(e),
    );
    await handle.to('running');
    // grammY throws on ok:false, and the handle must not record a reaction that
    // never landed — otherwise the next transition tries to replace a ghost.
    assert.equal(handle.applied, null);
    assert.equal(errors.length, 1);
});

test('every reaction call carries a bounded signal', async () => {
    // Without one these inherit grammY's 500s default and can outlive a shutdown.
    const seen: (AbortSignal | undefined)[] = [];
    const api: TelegramReactionApi = {
        raw: { async setMessageReaction(_args, signal) { seen.push(signal); return true; } },
    };
    await setTelegramReaction(api, 1, 2, '👀');
    assert.ok(seen[0] instanceof AbortSignal, 'a call with no signal is unbounded');
    assert.equal(seen[0]!.aborted, false);
});

test('an externally aborted signal propagates to the API call', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const api: TelegramReactionApi = {
        raw: { async setMessageReaction(_args, signal) { seen.push(signal); return true; } },
    };
    const controller = new AbortController();
    controller.abort();
    await setTelegramReaction(api, 1, 2, '👀', { signal: controller.signal });
    // The shutdown drain's signal has to reach the vendor call, not just the
    // wrapper around it.
    assert.equal(seen[0]!.aborted, true);
});

test('the timeout side of the composed signal actually fires', async () => {
    // Asserting a signal EXISTS is not the same as asserting it is bounded: a
    // never-aborting controller would satisfy that. This waits for the abort
    // event itself, so it fails if AbortSignal.timeout is dropped from the
    // composition.
    //
    // The vendor stub must not park on a promise that only an AbortSignal timer
    // can settle. node:test tears the event loop down when the last test
    // resolves, and a pending promise waiting on that timer races the teardown
    // — which is how this file died with cancelledByParent on CI while passing
    // locally every time.
    let observed: AbortSignal | undefined;
    const api: TelegramReactionApi = {
        raw: {
            async setMessageReaction(_args, signal) {
                observed = signal;
                return true;
            },
        },
    };
    // A live, never-aborted caller signal, so only the timeout can end this.
    const caller = new AbortController();
    await setTelegramReaction(api, 1, 2, '\u{1F440}', { signal: caller.signal, timeoutMs: 20 });
    // Observe the abort on the signal we were handed, with a bounded wait that
    // cannot outlive the test even if the composition is broken.
    assert.ok(observed, 'the vendor call must receive a signal');
    await new Promise<void>(resolve => {
        if (observed!.aborted) { resolve(); return; }
        const timer = setTimeout(resolve, 200);
        observed!.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    assert.equal(observed!.aborted, true, 'the composed signal must abort on timeout');
    assert.equal(caller.signal.aborted, false, 'the caller signal is untouched');
});

test('the exported transport is what production builds, not a test fixture', () => {
    // Guards the seam itself: if bot.ts ever hand-rolls its own adapter, the
    // behavior tests above would stop covering production.
    const { api } = fakeApi();
    const transport = createTelegramAckTransport(api, 1, 2);
    assert.equal(transport.mode, 'replace', 'Telegram replaces atomically');
    assert.equal(transport.coerce('\u{1F680}'), '\u{1F440}', 'the allowlist must be enforced here');
});
