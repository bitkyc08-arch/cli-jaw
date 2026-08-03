import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

// GET /api/slack/manifest serves the canonical manifest for the settings
// page copy button. Handler-level: no server boot.

const { registerSystemRoutes } = await import('../../src/routes/system.ts');

test('GET /api/slack/manifest returns the manifest yaml', () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => void>();
    const app = {
        get: (path: string, handler: (req: unknown, res: unknown) => void) => { handlers.set(path, handler); },
    };
    registerSystemRoutes(app as never, { jawAuthToken: 'test-token' });

    const handler = handlers.get('/api/slack/manifest');
    assert.ok(handler, 'route not registered');

    let payload: { ok?: boolean; data?: { yaml?: string } } | null = null;
    handler({}, { json: (body: unknown) => { payload = body as typeof payload; } });

    assert.equal(payload?.ok, true);
    const manifest = parse(payload?.data?.yaml || '');
    assert.equal(manifest.settings.socket_mode_enabled, true);
    assert.ok(manifest.oauth_config.scopes.bot.includes('chat:write'));
});
