import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

// GET /api/slack/manifest serves the canonical manifest for the settings
// page copy button. Handler-level: no server boot.

const { registerSystemRoutes } = await import('../../src/routes/system.ts');

test('GET /api/slack/manifest preserves the app name and derives the bot name', () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => void>();
    const app = {
        get: (path: string, handler: (req: unknown, res: unknown) => void) => { handlers.set(path, handler); },
    };
    registerSystemRoutes(app as never, { jawAuthToken: 'test-token' });

    const handler = handlers.get('/api/slack/manifest');
    assert.ok(handler, 'route not registered');

    let payload: { ok?: boolean; data?: { yaml?: string; json?: string; botDisplayName?: string } } | null = null;
    handler({ query: { name: 'Demo App' } }, { json: (body: unknown) => { payload = body as typeof payload; } });

    assert.equal(payload?.ok, true);
    const manifest = parse(payload?.data?.yaml || '');
    const jsonManifest = JSON.parse(payload?.data?.json || '{}');
    assert.equal(manifest.display_information.name, 'Demo App');
    assert.equal(manifest.features.bot_user.display_name, 'demo-app');
    assert.equal(jsonManifest.display_information.name, 'Demo App');
    assert.equal(jsonManifest.features.bot_user.display_name, 'demo-app');
    assert.equal(manifest.settings.socket_mode_enabled, true);
    assert.ok(manifest.oauth_config.scopes.bot.includes('chat:write'));
    assert.equal(payload?.data?.botDisplayName, 'demo-app');
});

test('GET /api/slack/manifest rejects an invalid app name', () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => void>();
    const app = {
        get: (path: string, handler: (req: unknown, res: unknown) => void) => { handlers.set(path, handler); },
    };
    registerSystemRoutes(app as never, { jawAuthToken: 'test-token' });

    const handler = handlers.get('/api/slack/manifest');
    assert.ok(handler, 'route not registered');

    let status = 200;
    let payload: { ok?: boolean; error?: string } | null = null;
    const res = {
        status: (code: number) => { status = code; return res; },
        json: (body: unknown) => { payload = body as typeof payload; },
    };
    handler({ query: { name: 'x'.repeat(36) } }, res);

    assert.equal(status, 400);
    assert.equal(payload?.ok, false);
    assert.equal(payload?.error, 'invalid_slack_app_name');
});

test('GET /api/slack/manifest rejects repeated name parameters', () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => void>();
    const app = {
        get: (path: string, handler: (req: unknown, res: unknown) => void) => { handlers.set(path, handler); },
    };
    registerSystemRoutes(app as never, { jawAuthToken: 'test-token' });

    const handler = handlers.get('/api/slack/manifest');
    assert.ok(handler, 'route not registered');

    let status = 200;
    const res = {
        status: (code: number) => { status = code; return res; },
        json: (_body: unknown) => undefined,
    };
    handler({ query: { name: ['first', 'second'] } }, res);

    assert.equal(status, 400);
});
