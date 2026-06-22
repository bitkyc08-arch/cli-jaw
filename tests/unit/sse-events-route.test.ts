import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerEventsRoutes } from '../../src/routes/events.ts';
import { broadcast } from '../../src/core/bus.ts';
import { publish, currentSeq } from '../../src/core/event-bus.ts';

function noAuth(_req: Request, _res: Response, next: NextFunction): void {
    next();
}

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
        // Aborted SSE sockets linger server-side until the next heartbeat
        // write fails — force-destroy them so close() resolves immediately.
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

/** Read from an SSE response body until pred matches or timeout. */
async function readUntil(
    body: ReadableStream<Uint8Array>,
    pred: (buffered: string) => boolean,
    timeoutMs = 3000,
): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const deadline = Date.now() + timeoutMs;
    try {
        while (Date.now() < deadline && !pred(buffered)) {
            const race = await Promise.race([
                reader.read(),
                new Promise<null>(resolve => setTimeout(() => resolve(null), 200)),
            ]);
            if (race === null) continue; // poll tick — re-check pred/deadline
            if (race.done) break;
            buffered += decoder.decode(race.value, { stream: true });
        }
    } finally {
        await reader.cancel().catch(() => { /* already closed */ });
    }
    return buffered;
}

test('SSE stream delivers live events in data-only format (no event: field)', async () => {
    await withServer(async baseUrl => {
        const ac = new AbortController();
        const res = await fetch(`${baseUrl}/api/events`, { signal: ac.signal });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
        assert.ok(res.body);

        // Give the subscription a beat to attach, then publish.
        setTimeout(() => publish('system', 'system_notice', { live: true }), 50);

        const out = await readUntil(res.body, buf => buf.includes('"live":true'));
        ac.abort();

        assert.ok(out.includes('"live":true'), `expected live event, got: ${out}`);
        assert.ok(out.includes('"topic":"system"'));
        assert.ok(out.includes('"event":"system_notice"'));
        // data-only contract: no SSE `event:` field lines anywhere
        assert.ok(!/^event: /m.test(out), `unexpected event: field in: ${out}`);
        assert.ok(/^id: \d+$/m.test(out));
    });
});

test('SSE replays events after lastEventId on reconnect', async () => {
    await withServer(async baseUrl => {
        const mark = currentSeq();
        publish('goal', 'goal_done', { replayed: 1 });
        publish('goal', 'goal_done', { replayed: 2 });

        const ac = new AbortController();
        const res = await fetch(`${baseUrl}/api/events?lastEventId=${mark}`, { signal: ac.signal });
        assert.ok(res.body);
        const out = await readUntil(res.body, buf => buf.includes('"replayed":2'));
        ac.abort();

        assert.ok(out.includes('"replayed":1'));
        assert.ok(out.includes('"replayed":2'));
        assert.ok(out.includes('"sseReplay":true'), `expected replay marker on replayed events, got: ${out}`);
        assert.ok(!/^event: /m.test(out));
    });
});

test('SSE live events do not carry the replay marker', async () => {
    await withServer(async baseUrl => {
        const ac = new AbortController();
        const res = await fetch(`${baseUrl}/api/events`, { signal: ac.signal });
        assert.equal(res.status, 200);
        assert.ok(res.body);

        setTimeout(() => publish('system', 'system_notice', { liveReplayMarkerCheck: true }), 50);

        const out = await readUntil(res.body, buf => buf.includes('"liveReplayMarkerCheck":true'));
        ac.abort();

        assert.ok(out.includes('"liveReplayMarkerCheck":true'), `expected live event, got: ${out}`);
        assert.ok(!out.includes('"sseReplay":true'), `live event must not be marked as replay: ${out}`);
    });
});

test('SSE signals replay_gap when lastEventId was evicted', async () => {
    await withServer(async baseUrl => {
        // Force eviction of id=1 so hasReplayGap(1) is deterministically true.
        const { RING_SIZE } = await import('../../src/core/event-bus.ts');
        for (let i = 0; i < RING_SIZE + 5; i++) publish('system', 'system_notice', { i });

        const ac = new AbortController();
        const res = await fetch(`${baseUrl}/api/events?lastEventId=1`, { signal: ac.signal });
        assert.ok(res.body);
        const out = await readUntil(res.body, buf => buf.includes('replay_gap'));
        ac.abort();

        assert.ok(out.includes('"event":"replay_gap"'), `expected replay_gap, got: ${out.slice(0, 200)}`);
        assert.ok(!/^event: /m.test(out));
    });
});

test('SSE signals replay_gap when the cursor is AHEAD of the current seq (pre-restart cursor)', async () => {
    await withServer(async baseUrl => {
        // A client that survived a server restart holds a lastEventId from the
        // previous process. The new ring's ids restart near 0, so replaySince
        // finds nothing and the eviction check stays false — without the
        // explicit ahead-of-seq guard the client is silently treated as
        // caught-up and every event since the restart is lost (260612 audit
        // 07 F-W2).
        const staleCursor = currentSeq() + 100_000;

        const ac = new AbortController();
        const res = await fetch(`${baseUrl}/api/events?lastEventId=${staleCursor}`, { signal: ac.signal });
        assert.ok(res.body);
        const out = await readUntil(res.body, buf => buf.includes('replay_gap'));
        ac.abort();

        assert.ok(out.includes('"event":"replay_gap"'), `expected replay_gap for ahead-of-seq cursor, got: ${out.slice(0, 200)}`);
    });
});

test('SSE streams safe worker_run events without raw output fields', async () => {
    await withServer(async baseUrl => {
        const ac = new AbortController();
        const res = await fetch(`${baseUrl}/api/events`, { signal: ac.signal });
        assert.equal(res.status, 200);
        assert.ok(res.body);

        setTimeout(() => broadcast('worker_run_done', {
            runId: 'wr_backend_sse',
            safeSummary: 'done',
            outputBytes: 12,
        }), 50);

        const out = await readUntil(res.body, buf => buf.includes('worker_run_done'));
        ac.abort();

        assert.ok(out.includes('"topic":"worker"'));
        assert.ok(out.includes('"event":"worker_run_done"'));
        assert.ok(out.includes('"safeSummary":"done"'));
        assert.ok(!out.includes('raw output'));
        assert.ok(!out.includes('outputFile'));
    });
});
