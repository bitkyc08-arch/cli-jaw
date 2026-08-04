import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerEventsRoutes } from '../../src/routes/events.ts';
import { currentSeq, publish } from '../../src/core/event-bus.ts';

function noAuth(_req: Request, _res: Response, next: NextFunction): void { next(); }

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    registerEventsRoutes(app, noAuth);
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

async function readUntil(body: ReadableStream<Uint8Array>, marker: string): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const timeout = setTimeout(() => { void reader.cancel(); }, 2_000);
    try {
        while (!buffered.includes(marker)) {
            const result = await reader.read();
            if (result.done) break;
            buffered += decoder.decode(result.value, { stream: true });
        }
    } finally {
        clearTimeout(timeout);
        await reader.cancel().catch(() => {});
    }
    return buffered;
}

test('scope filter applies identically to replay and live events without a false replay gap', async () => {
    await withServer(async baseUrl => {
        publish('system', 'system_notice', { marker: 'scope-filter-primer' });
        const replayMark = currentSeq();
        publish('message', 'new_message', { scope: 'scope-A', marker: 'replay-A' });
        publish('message', 'new_message', { scope: 'scope-B', marker: 'replay-B' });

        const replay = await fetch(`${baseUrl}/api/events?scope=scope-A&lastEventId=${replayMark}`);
        assert.ok(replay.body);
        const replayOut = await readUntil(replay.body, 'replay-A');
        assert.ok(replayOut.includes('replay-A'));
        assert.ok(!replayOut.includes('replay-B'));
        assert.ok(!replayOut.includes('replay_gap'), 'filtered-out global ids are not replay gaps');

        const live = await fetch(`${baseUrl}/api/events?scope=scope-A`);
        assert.ok(live.body);
        setTimeout(() => {
            publish('message', 'new_message', { scope: 'scope-B', marker: 'live-B' });
            publish('message', 'new_message', { scope: 'scope-A', marker: 'live-A' });
        }, 25);
        const liveOut = await readUntil(live.body, 'live-A');
        assert.ok(liveOut.includes('live-A'));
        assert.ok(!liveOut.includes('live-B'));
    });
});

test('unfiltered SSE receives all scopes and scoped stale cursors still receive replay_gap', async () => {
    await withServer(async baseUrl => {
        const unfiltered = await fetch(`${baseUrl}/api/events`);
        assert.ok(unfiltered.body);
        setTimeout(() => {
            publish('message', 'new_message', { scope: 'scope-A', marker: 'all-A' });
            publish('message', 'new_message', { scope: 'scope-B', marker: 'all-B' });
        }, 25);
        const allOut = await readUntil(unfiltered.body, 'all-B');
        assert.ok(allOut.includes('all-A'));
        assert.ok(allOut.includes('all-B'));

        const staleCursor = currentSeq() + 100_000;
        const stale = await fetch(`${baseUrl}/api/events?scope=scope-A&lastEventId=${staleCursor}`);
        assert.ok(stale.body);
        const staleOut = await readUntil(stale.body, 'replay_gap');
        assert.ok(staleOut.includes('replay_gap'));
    });
});
