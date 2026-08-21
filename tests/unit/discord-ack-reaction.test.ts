// Discord ACK reactions + queue-notice cleanup.
//
// Two Discord-specific hazards drive these: discord.js caches CUSTOM reactions
// by emoji id rather than the `name:id` form we send (so re-resolving from the
// cache silently misses), and its high-level message helpers forward no request
// options (so notice cleanup has to go through client.rest to be cancellable).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDiscordAckTransport,
    createDiscordNoticeTransport,
} from '../../src/discord/reactions.ts';
import { createAckHandle, DISCORD_ACK_DEFAULTS } from '../../src/messaging/ack-reaction.ts';
import { createQueueNotice, QueueNoticeRegistry } from '../../src/messaging/queue-notice.ts';
import type { Message } from 'discord.js';

type RestCall = { verb: string; route: string; options: Record<string, unknown> };

function fakeMessage() {
    const reacted: string[] = [];
    const removed: string[] = [];
    const rest: RestCall[] = [];
    const cache = new Map<string, unknown>();
    const message = {
        id: 'M1',
        channelId: 'C1',
        client: {
            user: { id: 'BOT' },
            rest: {
                async put(route: string, options: Record<string, unknown>) {
                    rest.push({ verb: 'put', route, options });
                    if (route.includes('/reactions/')) reacted.push(route);
                },
                async delete(route: string, options: Record<string, unknown>) {
                    rest.push({ verb: 'delete', route, options });
                    if (route.includes('/reactions/')) removed.push(route);
                },
                async patch(route: string, options: Record<string, unknown>) {
                    rest.push({ verb: 'patch', route, options });
                },
            },
        },
        reactions: { cache },

    } as unknown as Message;
    return { message, reacted, removed, rest };
}

test('the ACK transport uses remove-then-add: Discord has no atomic replace', async () => {
    const { message, reacted, removed } = fakeMessage();
    const transport = createDiscordAckTransport(message);
    assert.equal(transport.mode, 'remove-then-add');
    const handle = createAckHandle({ ...DISCORD_ACK_DEFAULTS, enabled: true }, transport);
    await handle.to('running');
    await handle.settle('success');
    assert.equal(reacted.length, 2);
    assert.match(reacted[0]!, /reactions\/%F0%9F%91%80\/@me$|reactions\/👀\/@me$/);
    assert.equal(removed.length, 1, 'the running reaction must come off first');
    assert.match(removed[0]!, /\/messages\/M1\/reactions\/.+\/@me$/);
});

test('a CUSTOM emoji is removed by its canonical identifier, not via the cache', async () => {
    // The bug this guards: discord.js keys custom reactions by emoji ID, so
    // reactions.cache.get('name:id') returns undefined and optional chaining
    // then leaves the running reaction attached forever. The factory stores the
    // identifier it sent instead, so removal never needs that lookup.
    const { message, reacted, removed } = fakeMessage();
    const handle = createAckHandle(
        { ...DISCORD_ACK_DEFAULTS, enabled: true, emoji: { running: 'wave:12345', success: 'done:67890', failure: 'x:1' } },
        createDiscordAckTransport(message),
    );
    await handle.to('running');
    await handle.settle('success');
    assert.equal(reacted.length, 2, 'both custom reactions go out over REST');
    // Resolved through the identifier react() returned, not the name:id we sent —
    // discord.js caches custom reactions under the emoji ID.
    assert.equal(removed.length, 1, 'custom removal must still fire');
    // Routes URL-encodes the segment, which is what keeps Discord from answering
    // 10014 Unknown Emoji.
    assert.match(removed[0]!, /reactions\/wave%3A12345\/@me$/);
});

test('a failing reaction leaves the handle unchanged', async () => {
    const errors: unknown[] = [];
    const message = {
        id: 'M1', channelId: 'C1',
        client: {
            user: { id: 'BOT' },
            rest: { async put() { throw new Error('Missing Permissions'); }, async delete() { }, async patch() { } },
        },
        reactions: { cache: new Map() },
    } as unknown as Message;
    const handle = createAckHandle(
        { ...DISCORD_ACK_DEFAULTS, enabled: true },
        createDiscordAckTransport(message),
        (e) => errors.push(e),
    );
    await handle.to('running');
    assert.equal(handle.applied, null, 'a reaction that never landed must not be recorded');
    assert.equal(errors.length, 1);
});

test('notice cleanup goes through REST so the drain signal can cancel it', async () => {
    // message.delete()/edit() forward no options, so a high-level call could not
    // receive the shutdown signal at all.
    const { message, rest } = fakeMessage();
    const transport = createDiscordNoticeTransport(message);
    const controller = new AbortController();
    await transport.delete(controller.signal);
    assert.equal(rest[0]!.verb, 'delete');
    assert.match(rest[0]!.route, /channels\/C1\/messages\/M1/);
    // Composed with the factory's own timeout, so not reference-equal — what
    // matters is that the caller's cancellation still reaches the request.
    const passed = rest[0]!.options['signal'] as AbortSignal;
    assert.ok(passed instanceof AbortSignal);
    assert.equal(passed.aborted, false);
    controller.abort();
    assert.equal(passed.aborted, true, 'aborting the caller signal must abort the request');
});

test('an expired notice is rewritten in place, never deleted', async () => {
    const { message, rest } = fakeMessage();
    const transport = createDiscordNoticeTransport(message);
    await transport.edit('timed out');
    assert.equal(rest[0]!.verb, 'patch', 'a turn that never answered must keep a trace');
    assert.deepEqual(rest[0]!.options['body'], { content: 'timed out' });
    assert.equal(rest.some(c => c.verb === 'delete'), false);
});

// ─── Lifecycle boundaries ────────────────────────────
// These drive the queue-notice module the way bot.ts drives it, covering the
// two paths the reviewer found broken in the first Discord cut: a failed notice
// post that never entered the terminal, and a timeout that never unregistered.

test('a failed notice post still closes the turn out', async () => {
    // abandon() alone left the listener, the request-id claim, the timer and the
    // running reaction alive until the 5-minute timeout.
    const registry = new QueueNoticeRegistry();
    const notice = createQueueNotice({ expiredText: 'expired' });
    let settled: string | null = null;
    let unregister = () => { };
    const finishExpired = async () => {
        try {
            await Promise.allSettled([notice.close('expired'), (async () => { settled = 'failure'; })()]);
        } finally { unregister(); }
    };
    unregister = registry.add(() => finishExpired());

    notice.abandon();          // the post failed: no handle will ever arrive
    await finishExpired();     // ...and the turn is closed out anyway

    assert.equal(settled, 'failure', 'the ACK must not stay on running forever');
    assert.equal(registry.size, 0, 'a closed-out turn must not linger in the registry');
});

test('a timeout unregisters, so shutdown does not redo finished work', async () => {
    const registry = new QueueNoticeRegistry();
    const notice = createQueueNotice({ expiredText: 'expired' });
    const calls: string[] = [];
    notice.bind({
        async delete() { calls.push('delete'); },
        async edit(text) { calls.push('edit:' + text); },
    });
    let unregister = () => { };
    let ran = 0;
    const finishExpired = async () => {
        ran += 1;
        try { await notice.close('expired'); } finally { unregister(); }
    };
    unregister = registry.add(() => finishExpired());

    await finishExpired();            // the 5-minute timer fires
    assert.equal(registry.size, 0, 'the timeout must drop its registry entry');
    await registry.drain(100);       // ...then shutdown arrives

    assert.equal(ran, 1, 'shutdown must not re-run a turn the timeout already closed');
    assert.deepEqual(calls, ['edit:expired'], 'expired rewrites once, never deletes');
});

test('a delayed notice post that lands after completion is still cleaned up', async () => {
    // The live race: msg.reply for the notice is awaited, and the queued job can
    // settle during that await.
    const { message, rest } = fakeMessage();
    const notice = createQueueNotice({ expiredText: 'expired' });
    const closing = notice.close('answered');   // completion first
    notice.bind(createDiscordNoticeTransport(message));  // handle second
    await closing;
    assert.equal(rest.length, 1);
    assert.equal(rest[0]!.verb, 'delete', 'a late handle must still be removed');
});

test('a stuck REST call is actually aborted by the deadline, not just abandoned', async () => {
    // The weaker version of this test only checked that a signal appeared in an
    // options bag — which a REST layer could ignore entirely. This one holds the
    // request open until the signal fires, so it fails if the signal never
    // reaches the call or never aborts.
    let observed: AbortSignal | undefined;
    const message = {
        id: 'M1',
        channelId: 'C1',
        client: {
            user: { id: 'BOT' },
            rest: {
                async delete(_route: string, options: { signal?: AbortSignal }) {
                    observed = options.signal;
                    await new Promise<void>(resolve => {
                        if (options.signal?.aborted) { resolve(); return; }
                        options.signal?.addEventListener('abort', () => resolve(), { once: true });
                    });
                },
                async patch() { },
                async put() { },
            },
        },
        reactions: { cache: new Map() },
    } as unknown as Message;

    const notice = createQueueNotice({ expiredText: 'expired' });
    notice.bind(createDiscordNoticeTransport(message));
    const registry = new QueueNoticeRegistry();
    registry.add((signal) => notice.close('answered', signal));
    const started = Date.now();
    await registry.drain(60);
    assert.ok(Date.now() - started < 2000, 'the drain must not wait out a stuck call');
    assert.equal(observed?.aborted, true, 'the deadline must abort the request, not just stop waiting');
});

test('a close with no registry signal is still bounded on its own', async () => {
    // Ordinary delivery closes without a signal, and QueueNotice pins the first
    // one it gets — so if the factory did not compose its own timeout, the
    // common path would be unbounded and a later drain could not fix it.
    let observed: AbortSignal | undefined;
    const message = {
        id: 'M1', channelId: 'C1',
        client: {
            user: { id: 'BOT' },
            rest: { async delete(_r: string, o: { signal?: AbortSignal }) { observed = o.signal; }, async patch() { }, async put() { } },
        },
        reactions: { cache: new Map() },
    } as unknown as Message;
    const transport = createDiscordNoticeTransport(message);
    await transport.delete();   // no signal supplied
    assert.ok(observed instanceof AbortSignal, 'the factory must supply its own timeout');
});

test('an ANIMATED custom emoji round-trips through the same identifier path', () => {
    // Animated emoji carry an a: prefix (a:name:id) and must survive unchanged
    // into the REST route, encoded rather than reinterpreted.
    const { message } = fakeMessage();
    const transport = createDiscordAckTransport(message);
    assert.equal(transport.coerce('a:spin:987'), 'a:spin:987');
});
