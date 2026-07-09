// ─── /queue TUI command (260703 tui_steer_esc_rca doc 30 §A1) ────────────
// Listing is authoritative from GET /api/orchestrate/snapshot; <n> resolves
// against the ids pinned by the last listing and re-verifies against a fresh
// snapshot before acting (queue renumbers as it drains); actions hit the same
// routes the Web UI pending-queue buttons use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runQueueCommand } from '../../bin/commands/tui/queue-command.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';

type QueueItem = { id: string; prompt: string; source?: string; ts?: number };

function makeCtx(apiUrl: string): TuiContext {
    return { apiUrl } as unknown as TuiContext;
}

interface Fixture {
    server: Server;
    url: string;
    requests: Array<{ method: string; path: string }>;
    queued: QueueItem[];
}

function startFixture(initial: QueueItem[]): Promise<Fixture> {
    return new Promise((resolve) => {
        const fixture: Partial<Fixture> = { requests: [], queued: [...initial] };
        const server = createServer((req, res) => {
            fixture.requests!.push({ method: req.method || '', path: req.url || '' });
            const respond = (status: number, json: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(json));
            };
            const url = req.url || '';
            if (req.method === 'GET' && url === '/api/orchestrate/snapshot') {
                respond(200, { queued: fixture.queued });
                return;
            }
            const steerMatch = url.match(/^\/api\/orchestrate\/queue\/([^/]+)\/steer$/);
            if (req.method === 'POST' && steerMatch) {
                const id = decodeURIComponent(steerMatch[1]!);
                const exists = fixture.queued!.some(i => i.id === id);
                if (!exists) { respond(404, { ok: false, error: 'queued item not found' }); return; }
                fixture.queued = fixture.queued!.filter(i => i.id !== id);
                respond(200, { ok: true, pending: fixture.queued.length });
                return;
            }
            const dropMatch = url.match(/^\/api\/orchestrate\/queue\/([^/]+)$/);
            if (req.method === 'DELETE' && dropMatch) {
                const id = decodeURIComponent(dropMatch[1]!);
                const exists = fixture.queued!.some(i => i.id === id);
                if (!exists) { respond(404, { ok: false, error: 'queued item not found' }); return; }
                fixture.queued = fixture.queued!.filter(i => i.id !== id);
                respond(200, { ok: true, pending: fixture.queued.length });
                return;
            }
            respond(404, { ok: false, error: 'route not found' });
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            fixture.server = server;
            fixture.url = `http://127.0.0.1:${port}`;
            resolve(fixture as Fixture);
        });
    });
}

const ITEMS: QueueItem[] = [
    { id: 'q-aaa', prompt: 'first queued prompt', source: 'web', ts: 1 },
    { id: 'q-bbb', prompt: 'second queued prompt', source: 'cli', ts: 2 },
    { id: 'q-ccc', prompt: 'third queued prompt', source: 'telegram', ts: 3 },
];

test('/queue lists items from the snapshot and pins ids for later actions', async () => {
    const fx = await startFixture(ITEMS);
    try {
        const ctx = makeCtx(fx.url);
        const result = await runQueueCommand(ctx, []);
        assert.equal(result.ok, true);
        assert.match(result.text, /1\. \[web\] first queued prompt/);
        assert.match(result.text, /3\. \[telegram\] third queued prompt/);
        assert.deepEqual(ctx.queueListIds, ['q-aaa', 'q-bbb', 'q-ccc']);
        assert.equal(ctx.queueItems?.length, 3);
    } finally {
        fx.server.close();
    }
});

test('/queue steer <n> resolves the pinned id, re-verifies, and POSTs the steer route', async () => {
    const fx = await startFixture(ITEMS);
    try {
        const ctx = makeCtx(fx.url);
        await runQueueCommand(ctx, []);
        const result = await runQueueCommand(ctx, ['steer', '2']);
        assert.equal(result.ok, true);
        assert.equal(result.steered, true);
        assert.match(result.text, /second queued prompt/);
        assert.ok(fx.requests.some(r => r.method === 'POST' && r.path === '/api/orchestrate/queue/q-bbb/steer'));
    } finally {
        fx.server.close();
    }
});

test('/queue drop <n> deletes the pinned item and reports remaining count', async () => {
    const fx = await startFixture(ITEMS);
    try {
        const ctx = makeCtx(fx.url);
        await runQueueCommand(ctx, []);
        const result = await runQueueCommand(ctx, ['drop', '3']);
        assert.equal(result.ok, true);
        assert.match(result.text, /third queued prompt/);
        assert.match(result.text, /2 left/);
        assert.ok(fx.requests.some(r => r.method === 'DELETE' && r.path === '/api/orchestrate/queue/q-ccc'));
    } finally {
        fx.server.close();
    }
});

test('/queue action on a drained item refuses instead of hitting the wrong target', async () => {
    const fx = await startFixture(ITEMS);
    try {
        const ctx = makeCtx(fx.url);
        await runQueueCommand(ctx, []);
        // Item 2 drains server-side between the listing and the action.
        fx.queued = fx.queued.filter(i => i.id !== 'q-bbb');
        const result = await runQueueCommand(ctx, ['drop', '2']);
        assert.equal(result.ok, false);
        assert.match(result.text, /Queue changed/);
        // No DELETE must have fired — the stale index would now point at q-ccc.
        assert.equal(fx.requests.some(r => r.method === 'DELETE'), false);
    } finally {
        fx.server.close();
    }
});

test('/queue action without a prior listing asks for /queue first', async () => {
    const fx = await startFixture(ITEMS);
    try {
        const ctx = makeCtx(fx.url);
        const result = await runQueueCommand(ctx, ['steer', '1']);
        assert.equal(result.ok, false);
        assert.match(result.text, /Run \/queue first/);
    } finally {
        fx.server.close();
    }
});

test('/queue with empty server queue reports empty', async () => {
    const fx = await startFixture([]);
    try {
        const ctx = makeCtx(fx.url);
        const result = await runQueueCommand(ctx, []);
        assert.equal(result.ok, true);
        assert.match(result.text, /empty/i);
    } finally {
        fx.server.close();
    }
});
