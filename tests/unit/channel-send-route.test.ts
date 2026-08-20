import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerMessagingRoutes } from '../../src/routes/messaging.ts';

async function withMessagingServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    const passAuth = (_req: Request, _res: Response, next: NextFunction) => next();
    registerMessagingRoutes(app, passAuth);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

test('POST /api/channel/send returns the stable invalid_channel envelope with an actionable Slack hint', async () => {
    await withMessagingServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/api/channel/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ channel: 'C123ABC', type: 'text', text: 'hello' }),
        });
        const body = await response.json() as { error?: string; code?: string };

        assert.equal(response.status, 400);
        assert.equal(body.code, 'invalid_channel');
        assert.match(body.error ?? '', /channel is (?:a )?transport/i);
        assert.match(body.error ?? '', /chat_id|target\.targetId/);
        assert.doesNotMatch(body.error ?? '', /xox[baprs]-|C123ABC|lastActive|latestSeen/);
    });
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The guard refuses correctly; the question is whether the refusal survives the
// route intact. `forbidden()` grew a `code` and a `detail`, and getting that
// object shape wrong turns a 403 into a 500 — the top regression this guards
// (#404). The unit tests cover the guard; only this covers the chain
// forbidden → httpDetail → response JSON.
test('POST /api/channel/send refuses a path outside the roots with a 403 that says where they are', async () => {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-route-home-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-route-outside-'));
    const filePath = path.join(outside, 'report.png');
    try {
        process.env.CLI_JAW_HOME = testHome;
        // The file must exist: a missing one is refused earlier, as
        // path_not_resolvable, and would not exercise this branch at all.
        fs.writeFileSync(filePath, 'x');

        await withMessagingServer(async baseUrl => {
            const response = await fetch(`${baseUrl}/api/channel/send`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    channel: 'slack', type: 'file', filePath,
                    target: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_ROUTE' },
                }),
            });
            const body = await response.json() as { code?: string; detail?: { allowedRoots?: string[] } };

            assert.equal(response.status, 403, 'a refused path must not surface as a 500');
            assert.equal(body.code, 'path_not_allowed');
            const roots = body.detail?.allowedRoots;
            assert.ok(Array.isArray(roots) && roots.length > 0, `the response must name the roots; saw ${JSON.stringify(body)}`);
            assert.ok(
                roots.includes(fs.realpathSync(testHome)),
                `JAW_HOME must be among them; saw ${JSON.stringify(roots)}`,
            );
        });
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        fs.rmSync(testHome, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

// The same guard sits behind the send routes, and each builds its own error
// response. Covering only /api/channel/send would leave the copies free to
// drift back to a bare 500 (#404).
//
// /api/telegram/send is not here: it requires a configured client and answers
// 503 before the guard runs, so it cannot reach this branch without standing up
// a Telegram transport. Its error shape is the same expression as the others.
test('every send route surfaces a refused path the same way', async () => {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-routes-home-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-routes-outside-'));
    const filePath = path.join(outside, 'report.png');
    try {
        process.env.CLI_JAW_HOME = testHome;
        fs.writeFileSync(filePath, 'x');

        await withMessagingServer(async baseUrl => {
            for (const [route, body] of [
                ['/api/slack/send', {
                    type: 'file', filePath,
                    target: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_ROUTE' },
                }],
                ['/api/discord/send', {
                    type: 'file', filePath,
                    target: { channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: '123' },
                }],
            ] as const) {
                const response = await fetch(`${baseUrl}${route}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const json = await response.json() as { code?: string; detail?: { allowedRoots?: string[] } };

                assert.equal(response.status, 403, `${route} must refuse with 403, not 500`);
                assert.equal(json.code, 'path_not_allowed', `${route} must name the refusal`);
                assert.ok(
                    Array.isArray(json.detail?.allowedRoots) && json.detail!.allowedRoots!.length > 0,
                    `${route} must say where the roots are; saw ${JSON.stringify(json)}`,
                );
            }
        });
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        fs.rmSync(testHome, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
