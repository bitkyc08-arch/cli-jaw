// A token can pass auth.test and still fail the first real upload because the
// app never got files:write. That happened live: a DOCX upload died on
// missing_scope and the operator had to be told which scope by hand. These
// tests pin the preflight that catches it at setup time instead.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    REQUIRED_SLACK_BOT_SCOPES,
    SLACK_CAPABILITY_SCOPES,
    missingSlackCapabilityScopes,
    missingSlackScopes,
    validateChannelCredentials,
} from '../../src/messaging/channel-validate.ts';
import { describeSlackError, neededScopeFrom } from '../../src/slack/api.ts';
import { SLACK_APP_MANIFEST } from '../../src/slack/manifest.ts';
import { registerMessagingRoutes } from '../../src/routes/messaging.ts';
import type { Express } from 'express';

test('the required scope list matches the shipped app manifest', () => {
    // Drift here means the wizard would approve a token the transport cannot use.
    assert.deepEqual(
        [...REQUIRED_SLACK_BOT_SCOPES, ...SLACK_CAPABILITY_SCOPES].sort(),
        [...SLACK_APP_MANIFEST.oauth_config.scopes.bot].sort(),
    );
});

test('a granted superset passes, a gap is reported in order', () => {
    const all = REQUIRED_SLACK_BOT_SCOPES.join(',');
    assert.deepEqual(missingSlackScopes(all), []);
    assert.deepEqual(missingSlackScopes(`${all},incoming-webhook`), [], 'extra scopes are fine');

    const withoutFiles = REQUIRED_SLACK_BOT_SCOPES.filter(s => s !== 'files:write').join(', ');
    assert.deepEqual(missingSlackScopes(withoutFiles), ['files:write']);
});

test('an absent header means "cannot check", not "everything missing"', () => {
    assert.deepEqual(missingSlackScopes(null), []);
    assert.deepEqual(missingSlackScopes(''), []);
});

test('files:read is a non-blocking capability while core gaps still fail', async () => {
    const coreOnly = REQUIRED_SLACK_BOT_SCOPES.join(',');
    assert.deepEqual(missingSlackCapabilityScopes(coreOnly), ['files:read']);
    const fetchImpl = (async () => ({
        ok: true,
        headers: { get: () => coreOnly },
        json: async () => ({ ok: true, user: 'cli-jaw', team_id: 'T1' }),
    } as unknown as Response)) as typeof fetch;
    assert.deepEqual(
        await validateChannelCredentials({ channel: 'slack', botToken: 'xoxb-1' }, fetchImpl),
        { ok: true, identity: 'cli-jaw', teamId: 'T1', missingCapabilities: ['files:read'] },
    );
});

test('/api/channels/validate preserves missingCapabilities in its success JSON', async () => {
    const routes = new Map<string, (...args: unknown[]) => unknown>();
    const app = {
        post(path: string, ...handlers: Array<(...args: unknown[]) => unknown>) {
            routes.set(path, handlers.at(-1)!);
        },
    } as unknown as Express;
    registerMessagingRoutes(app, ((_req: unknown, _res: unknown, next: () => void) => next()) as never);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
        ok: true,
        headers: { get: () => REQUIRED_SLACK_BOT_SCOPES.join(',') },
        json: async () => ({ ok: true, user: 'cli-jaw', team_id: 'T1' }),
    } as unknown as Response)) as typeof fetch;
    let payload: unknown;
    try {
        await routes.get('/api/channels/validate')!(
            { body: { channel: 'slack', botToken: 'xoxb-1' } },
            { json(value: unknown) { payload = value; } },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.deepEqual(payload, {
        ok: true,
        identity: 'cli-jaw',
        teamId: 'T1',
        missingCapabilities: ['files:read'],
    });
});

test('validation reports the missing scopes instead of a bare pass', async () => {
    const fetchImpl = (async (url: string | URL) => {
        const u = String(url);
        const headers = { get: (k: string) => (k === 'x-oauth-scopes' ? 'chat:write,commands' : null) };
        return {
            ok: true,
            headers,
            json: async () => (u.includes('auth.test') ? { ok: true, user: 'cli-jaw', team_id: 'T1' } : { ok: true }),
        } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await validateChannelCredentials({ channel: 'slack', botToken: 'xoxb-1' }, fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_scopes');
    assert.ok(result.missing?.includes('files:write'), 'the upload-blocking scope must be named');
    assert.ok(result.missing?.includes('im:history'));
});

test('a fully scoped token still validates', async () => {
    const granted = [...REQUIRED_SLACK_BOT_SCOPES, ...SLACK_CAPABILITY_SCOPES].join(',');
    const fetchImpl = (async () => ({
        ok: true,
        headers: { get: () => granted },
        json: async () => ({ ok: true, user: 'cli-jaw', team_id: 'T1' }),
    } as unknown as Response)) as unknown as typeof fetch;

    assert.deepEqual(await validateChannelCredentials({ channel: 'slack', botToken: 'xoxb-1' }, fetchImpl),
        { ok: true, identity: 'cli-jaw', teamId: 'T1' });
});

test('a runtime missing_scope names the scope Slack asked for', () => {
    assert.equal(neededScopeFrom({ needed: 'files:write' }), 'files:write');
    assert.equal(neededScopeFrom({ response_metadata: { messages: ['missing scope: files:write'] } }),
        'missing scope: files:write');
    assert.equal(neededScopeFrom({}), '');

    const named = describeSlackError('missing_scope', { needed: 'files:write' });
    assert.match(named, /files:write/);
    assert.match(named, /reinstall/i);
    // Without a hint the message still tells the operator where to go.
    assert.match(describeSlackError('missing_scope'), /OAuth & Permissions/);
});
