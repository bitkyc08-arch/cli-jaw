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
                },
                async patch(route: string, options: Record<string, unknown>) {
                    rest.push({ verb: 'patch', route, options });
                },
            },
        },
        reactions: { cache },
        async react(emoji: string) {
            reacted.push(emoji);
            // The real API hands back the MessageReaction; keeping it is the only
            // reliable way to remove a custom emoji later.
            return { users: { async remove(id: string) { removed.push(`${emoji}:${id}`); } } };
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
    assert.deepEqual(removed, ['👀:BOT'], 'the running reaction must come off first');
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
    assert.deepEqual(removed, ['wave:12345:BOT'], 'custom removal must still fire');
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
