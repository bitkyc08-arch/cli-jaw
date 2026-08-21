import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, CHANNEL_CAPABILITY_KEYS } from '../../src/messaging/channel-capabilities.ts';
import { DISCORD_MESSAGE_LIMIT } from '../../src/discord/forwarder.ts';
import { SLACK_MESSAGE_LIMIT } from '../../src/slack/format.ts';
import { RICH_MESSAGE_LIMIT } from '../../src/telegram/rich-message.ts';
import {
    discordDeliveryError,
    slackDeliveryError,
    telegramDeliveryError,
} from '../../src/messaging/delivery-outcome.ts';
import type { MessengerChannel } from '../../src/messaging/types.ts';
import { slackApi } from '../../src/slack/api.ts';

test('Telegram preserves rate-limit, format, and ambiguous send semantics', () => {
    assert.deepEqual(
        telegramDeliveryError({
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 3 },
        }),
        {
            kind: 'rate-limit',
            retryAfterMs: 3_000,
            code: '429',
            message: 'Too Many Requests',
        },
    );
    assert.equal(telegramDeliveryError({
        error_code: 400,
        description: "Bad Request: can't parse entities",
    }).kind, 'format');
    assert.equal(telegramDeliveryError({
        error_code: 400,
        description: 'Bad Request: chat not found',
    }).kind, 'ambiguous');
    assert.equal(telegramDeliveryError({ error_code: 500, description: 'Server error' }).kind, 'ambiguous');
});

test('Slack maps provider error codes and preserves a rate-limit delay', () => {
    assert.equal(slackDeliveryError({ code: 'invalid_auth' }).kind, 'auth');
    assert.equal(slackDeliveryError({ code: 'channel_not_found' }).kind, 'not-found');
    assert.equal(slackDeliveryError({ code: 'missing_scope' }).kind, 'permission');
    assert.deepEqual(slackDeliveryError({
        code: 'ratelimited',
        status: 429,
        retryAfterMs: 1_250,
    }), {
        kind: 'rate-limit',
        retryAfterMs: 1_250,
        code: 'ratelimited',
        message: 'ratelimited',
    });
});

test('slackApi parses Retry-After seconds and omits invalid values', async () => {
    const fetchWithRetryAfter = (value: string | null): typeof fetch => (async () => {
        const headers = value === null ? undefined : { 'Retry-After': value };
        return new Response('{"ok":false,"error":"ratelimited"}', { status: 429, headers });
    }) as typeof fetch;

    const limited = await slackApi('token', 'chat.postMessage', {}, {
        fetchImpl: fetchWithRetryAfter('1.25'),
    });
    assert.equal(limited.retryAfterMs, 1_250);

    for (const value of [null, '', '-1', 'not-a-number']) {
        const result = await slackApi('token', 'chat.postMessage', {}, {
            fetchImpl: fetchWithRetryAfter(value),
        });
        assert.equal('retryAfterMs' in result, false, String(value));
    }
});

test('Discord maps HTTP status failures', () => {
    assert.equal(discordDeliveryError({ status: 401 }).kind, 'auth');
    assert.equal(discordDeliveryError({ status: 403 }).kind, 'permission');
    assert.equal(discordDeliveryError({ status: 404 }).kind, 'not-found');
    assert.equal(discordDeliveryError({ status: 429, retryAfterMs: 2_000 }).kind, 'rate-limit');
});

test('only explicit pre-dispatch evidence makes a transport failure transient', () => {
    const refused = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED', dispatched: false };
    assert.equal(discordDeliveryError(refused).kind, 'transient');
    assert.equal(slackDeliveryError(refused).kind, 'transient');

    const socketHangUp = { code: 'ECONNRESET', message: 'socket hang up' };
    assert.equal(discordDeliveryError(socketHangUp).kind, 'ambiguous');
    assert.equal(slackDeliveryError(socketHangUp).kind, 'ambiguous');
    assert.equal(discordDeliveryError({ ...refused, dispatched: true }).kind, 'ambiguous');
});

test('every MessengerChannel declares the closed capability key set, no more and no less', () => {
    const channels = ['telegram', 'discord', 'slack'] as const satisfies readonly MessengerChannel[];
    const expectedKeys = [...CHANNEL_CAPABILITY_KEYS].sort();

    for (const channel of channels) {
        const declared = Object.keys(capabilitiesFor(channel)).sort();
        assert.deepEqual(declared, expectedKeys, `${channel} must declare exactly the closed key set`);
    }
});

test('capability declarations match what this tree can actually call', () => {
    // These are not aspirations. Each false below has no call site in the tree, and
    // each was verified by search when the closed set was introduced: Discord has no
    // edit or delete call and no component handler, Slack routes interactive events to
    // a log and uses edited progress instead of a typing indicator, and no channel
    // calls a reaction API at all.
    assert.deepEqual(capabilitiesFor('discord').editText, false);
    assert.deepEqual(capabilitiesFor('discord').deleteMessage, false);
    assert.deepEqual(capabilitiesFor('discord').interactiveActions, false);
    assert.deepEqual(capabilitiesFor('slack').interactiveActions, false);
    assert.deepEqual(capabilitiesFor('slack').typing, false);
    // Slack gained a real reaction call site with the inbound ACK (#412); the
    // other two are still declaration-only until their own phases wire them.
    assert.equal(capabilitiesFor('slack').reaction, true, 'slack reacts via reactions.add');
    assert.equal(capabilitiesFor('telegram').reaction, true, 'telegram reacts via setMessageReaction');
    // Discord is still declaration-only until its own phase wires it.
    assert.equal(capabilitiesFor('discord').reaction, false, 'discord has no reaction call site');
    for (const channel of ['telegram', 'discord', 'slack'] as const) {
        assert.equal(capabilitiesFor(channel).sendText, true);
    }
});

test('durableIngress is declared only where dedupe survives a restart', () => {
    // All three now record inbound events in the shared SQLite journal, so
    // 'already handled' outlives the process that handled it.
    assert.equal(capabilitiesFor('telegram').durableIngress, true);
    assert.equal(capabilitiesFor('slack').durableIngress, true);
    // Discord kept a TTL set in memory until M3d put its messages in the shared
    // journal; a restart no longer forgets what it already handled.
    assert.equal(capabilitiesFor('discord').durableIngress, true);
});

test('declared message limits are the limits the chunkers actually apply', () => {
    // A declaration that drifts from the chunker is worse than no declaration: it
    // reads as verified. Bind them here so changing one without the other fails.
    assert.equal(capabilitiesFor('discord').maxMessageChars, DISCORD_MESSAGE_LIMIT);
    assert.equal(capabilitiesFor('slack').maxMessageChars, SLACK_MESSAGE_LIMIT);
    assert.equal(capabilitiesFor('telegram').maxMessageChars, RICH_MESSAGE_LIMIT);
});
