import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor } from '../../src/messaging/channel-capabilities.ts';
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

test('every MessengerChannel has the expected capabilities', () => {
    const channels = ['telegram', 'discord', 'slack'] as const satisfies readonly MessengerChannel[];
    const expected = {
        telegram: 32_000,
        discord: 2_000,
        slack: 3_900,
    } as const satisfies Record<MessengerChannel, number>;

    for (const channel of channels) {
        assert.deepEqual(capabilitiesFor(channel), {
            editMessages: true,
            threads: true,
            interactiveComponents: true,
            fileUpload: true,
            durableOffset: false,
            maxMessageChars: expected[channel],
        });
    }
});
