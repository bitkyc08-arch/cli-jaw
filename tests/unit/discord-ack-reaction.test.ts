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
        async react(emoji: string) {
            reacted.push(emoji);
            // The real API hands back the MessageReaction carrying the canonical
            // REST identifier — the only reliable handle for a custom emoji.
            return { emoji: { identifier: emoji.includes(':') ? `x${emoji.split(':')[1]}` : emoji } };
        },
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
    assert.deepEqual(reacted, ['👀', '✅']);
    assert.equal(removed.length, 1, 'the running reaction must come off first');
    assert.match(removed[0]!, /\/messages\/M1\/reactions\/.+\/@me$/);
});

test('a CUSTOM emoji is removed via the returned handle, not the cache', async () => {
    // The bug this guards: discord.js keys custom reactions by emoji ID, so
    // reactions.cache.get('name:id') returns undefined and optional chaining
    // then leaves the running reaction attached forever.
    const { message, reacted, removed } = fakeMessage();
    const handle = createAckHandle(
        { ...DISCORD_ACK_DEFAULTS, enabled: true, emoji: { running: 'wave:12345', success: 'done:67890', failure: 'x:1' } },
        createDiscordAckTransport(message),
    );
    await handle.to('running');
    await handle.settle('success');
    assert.deepEqual(reacted, ['wave:12345', 'done:67890']);
    // Resolved through the identifier react() returned, not the name:id we sent —
    // discord.js caches custom reactions under the emoji ID.
    assert.equal(removed.length, 1, 'custom removal must still fire');
    assert.match(removed[0]!, /reactions\/x12345\/@me$/);
});

test('a failing reaction leaves the handle unchanged', async () => {
    const errors: unknown[] = [];
    const message = {
        client: { user: { id: 'BOT' } },
        reactions: { cache: new Map() },
        async react() { throw new Error('Missing Permissions'); },
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
    assert.equal(rest[0]!.options['signal'], controller.signal);
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
