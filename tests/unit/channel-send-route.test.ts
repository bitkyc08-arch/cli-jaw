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
