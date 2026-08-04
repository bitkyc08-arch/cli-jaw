// Live credential validation behind the onboarding wizard's Validate button.
// Injected fetch: the suite never touches Telegram/Discord/Slack.
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChannelCredentials } from '../../src/messaging/channel-validate.ts';
import { REQUIRED_SLACK_BOT_SCOPES, SLACK_CAPABILITY_SCOPES } from '../../src/messaging/channel-validate.ts';

type Route = { ok?: boolean; json?: unknown };

function fakeFetch(routes: Record<string, Route>, grantedScopes?: readonly string[]) {
    const calls: string[] = [];
    // Slack's real responses carry the granted scopes; without this header the
    // preflight silently skips and these cases would not exercise the token
    // path they claim to.
    const granted = (grantedScopes ?? REQUIRED_SLACK_BOT_SCOPES).join(',');
    const headers = { get: (k: string) => (k === 'x-oauth-scopes' ? granted : null) };
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
    }, [...REQUIRED_SLACK_BOT_SCOPES, ...SLACK_CAPABILITY_SCOPES]);
    assert.deepEqual(await validateChannelCredentials(
        { channel: 'slack', botToken: 'xoxb-1', appToken: 'xapp-1' }, fn),
        { ok: true, identity: 'cli-jaw', teamId: 'T1' });
    assert.equal(calls.length, 2);
});

// files:read is a CAPABILITY scope, not a core one: a text-only workspace must
// still validate successfully so existing installs can re-save their settings.
// It only reports the gap so the wizard can show a non-blocking reinstall hint.
test('slack validation succeeds without files:read but reports the capability gap', async () => {
    const { fn } = fakeFetch({
        'auth.test': { json: { ok: true, user: 'cli-jaw', team_id: 'T1' } },
    }, REQUIRED_SLACK_BOT_SCOPES);
    assert.deepEqual(await validateChannelCredentials({ channel: 'slack', botToken: 'xoxb-1' }, fn),
        { ok: true, identity: 'cli-jaw', teamId: 'T1', missingCapabilities: ['files:read'] });
});

test('a missing core scope still fails validation even when files:read is granted', async () => {
    const { fn } = fakeFetch({
        'auth.test': { json: { ok: true, user: 'cli-jaw', team_id: 'T1' } },
    }, [...REQUIRED_SLACK_BOT_SCOPES.filter(scope => scope !== 'chat:write'), 'files:read']);
    assert.deepEqual(await validateChannelCredentials({ channel: 'slack', botToken: 'xoxb-1' }, fn),
        { ok: false, error: 'missing_scopes', missing: ['chat:write'] });
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
