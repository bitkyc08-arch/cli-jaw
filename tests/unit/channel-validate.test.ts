// Live credential validation behind the onboarding wizard's Validate button.
// Injected fetch: the suite never touches Telegram/Discord/Slack.
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChannelCredentials } from '../../src/messaging/channel-validate.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../../src/messaging/channel-validate.ts';

type Route = { ok?: boolean; json?: unknown };

function fakeFetch(routes: Record<string, Route>) {
    const calls: string[] = [];
    // Slack's real responses carry the granted scopes; without this header the
    // preflight silently skips and these cases would not exercise the token
    // path they claim to.
    const headers = { get: (k: string) => (k === 'x-oauth-scopes' ? REQUIRED_SLACK_BOT_SCOPES.join(',') : null) };
    const fn = async (url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        for (const [needle, r] of Object.entries(routes)) {
            if (u.includes(needle)) {
                return { ok: r.ok !== false, headers, json: async () => r.json ?? {} } as unknown as Response;
            }
        }
        throw new Error('unreachable');
    };
    return { calls, fn: fn as unknown as typeof fetch };
}

test('an empty token never reaches the network', async () => {
    const { calls, fn } = fakeFetch({});
    const r = await validateChannelCredentials({ channel: 'telegram', botToken: '  ' }, fn);
    assert.deepEqual(r, { ok: false, error: 'token_required' });
    assert.equal(calls.length, 0);
});

test('telegram resolves the bot username from getMe', async () => {
    const { calls, fn } = fakeFetch({ 'api.telegram.org': { json: { ok: true, result: { username: 'jawbot' } } } });
    const r = await validateChannelCredentials({ channel: 'telegram', botToken: '123:ABC' }, fn);
    assert.deepEqual(r, { ok: true, identity: '@jawbot' });
    assert.ok(calls[0]?.includes('/getMe'));
});

test('telegram reports a rejected token instead of throwing', async () => {
    const { fn } = fakeFetch({ 'api.telegram.org': { json: { ok: false } } });
    assert.deepEqual(await validateChannelCredentials({ channel: 'telegram', botToken: 'bad' }, fn),
        { ok: false, error: 'invalid_token' });
});

test('discord needs a guild id even when the token is valid', async () => {
    const { fn } = fakeFetch({ 'discord.com': { json: { username: 'jaw' } } });
    assert.deepEqual(await validateChannelCredentials({ channel: 'discord', botToken: 'MTI' }, fn),
        { ok: false, error: 'guild_required' });
    assert.deepEqual(await validateChannelCredentials({ channel: 'discord', botToken: 'MTI', guildId: '123' }, fn),
        { ok: true, identity: 'jaw' });
});

test('slack checks the bot prefix before spending a request', async () => {
    const { calls, fn } = fakeFetch({});
    assert.deepEqual(await validateChannelCredentials({ channel: 'slack', botToken: 'xapp-1' }, fn),
        { ok: false, error: 'bot_prefix' });
    assert.equal(calls.length, 0, 'a swapped paste must not cost an API call');
});

test('slack returns the team id and validates the app token when present', async () => {
    const { calls, fn } = fakeFetch({
        'auth.test': { json: { ok: true, user: 'cli-jaw', team_id: 'T1' } },
        'apps.connections.open': { json: { ok: true } },
    });
    assert.deepEqual(await validateChannelCredentials(
        { channel: 'slack', botToken: 'xoxb-1', appToken: 'xapp-1' }, fn),
        { ok: true, identity: 'cli-jaw', teamId: 'T1' });
    assert.equal(calls.length, 2);
});

test('slack surfaces a bad app token separately from a bad bot token', async () => {
    const { fn } = fakeFetch({
        'auth.test': { json: { ok: true, user: 'cli-jaw' } },
        'apps.connections.open': { json: { ok: false } },
    });
    assert.deepEqual(await validateChannelCredentials(
        { channel: 'slack', botToken: 'xoxb-1', appToken: 'xapp-1' }, fn),
        { ok: false, error: 'invalid_app_token' });
});

test('a network failure is reported, never thrown', async () => {
    const fn = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    assert.deepEqual(await validateChannelCredentials({ channel: 'telegram', botToken: '1' }, fn),
        { ok: false, error: 'network' });
});
