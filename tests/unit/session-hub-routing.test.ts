import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import { registerMessageRoutes } from '../../src/routes/messages.ts';
import { registerSessionPageRoute, registerStaticRoutes } from '../../src/routes/static.ts';

function noAuth(_req: Request, _res: Response, next: NextFunction): void { next(); }

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

afterEach(() => {
    db.prepare("DELETE FROM messages WHERE session_id IN ('hub-a', 'hub-b')").run();
    db.prepare("DELETE FROM chat_sessions WHERE id IN ('hub-a', 'hub-b')").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
    settings.multiSession.enabled = false;
});

test('digits-only route serves index after static without capturing API, media, widget, or unknown paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jaw-session-route-'));
    mkdirSync(join(root, 'public', 'dist'), { recursive: true });
    writeFileSync(join(root, 'public', 'dist', 'index.html'), '<!doctype html><title>session-index-071</title>');
    writeFileSync(join(root, 'public', 'index.html'), '<!doctype html><title>source-index-071</title>');
    const app = express();
    registerStaticRoutes(app, noAuth, { projectRoot: root });
    app.use(express.static(join(root, 'public')));
    registerSessionPageRoute(app);
    app.get('/api/preserved', (_req, res) => res.status(418).send('api'));

    try {
        await withServer(app, async baseUrl => {
            for (const path of ['/1', '/1/']) {
                const response = await fetch(baseUrl + path);
                assert.equal(response.status, 200);
                assert.match(await response.text(), /session-index-071/);
            }
            assert.equal((await fetch(`${baseUrl}/api/preserved`)).status, 418);
            assert.equal((await fetch(`${baseUrl}/media/missing.png`)).status, 404);
            assert.equal((await fetch(`${baseUrl}/api/widgets/missing/widget`)).status, 404);
            assert.equal((await fetch(`${baseUrl}/not-a-session`)).status, 404);

            rmSync(join(root, 'public', 'dist', 'index.html'));
            const sourceFallback = await fetch(`${baseUrl}/2`);
            assert.equal(sourceFallback.status, 200);
            assert.match(await sourceFallback.text(), /source-index-071/);
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('?session=id scopes history, count, and search while absence preserves the active-session behavior', async () => {
    settings.multiSession.enabled = true;
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('hub-a', 920, 'A'), ('hub-b', 921, 'B')").run();
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'hub-only-a', 'hub-a'), ('user', 'hub-only-b', 'hub-b')").run();
    db.prepare("UPDATE session SET active_chat_session = 'hub-a' WHERE id = 'default'").run();
    const app = express();
    registerMessageRoutes(app);

    await withServer(app, async baseUrl => {
        const scoped = await (await fetch(`${baseUrl}/api/messages?session=hub-b`)).json() as { data: Array<{ content: string }> };
        const count = await (await fetch(`${baseUrl}/api/messages/count?session=hub-b`)).json() as { data: { count: number } };
        const search = await (await fetch(`${baseUrl}/api/messages/search?q=hub-only&session=hub-b`)).json() as { data: Array<{ content: string }> };
        const legacy = await (await fetch(`${baseUrl}/api/messages`)).json() as { data: Array<{ content: string }> };
        assert.deepEqual(scoped.data.map(row => row.content), ['hub-only-b']);
        assert.equal(count.data.count, 1);
        assert.deepEqual(search.data.map(row => row.content), ['hub-only-b']);
        assert.deepEqual(legacy.data.map(row => row.content), ['hub-only-a']);

        settings.multiSession.enabled = false;
        const off = await (await fetch(`${baseUrl}/api/messages`)).json() as { data: Array<{ content: string }> };
        assert.deepEqual(off, legacy);
    });
});
