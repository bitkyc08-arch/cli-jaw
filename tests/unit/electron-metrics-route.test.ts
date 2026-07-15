import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
    CLI_JAW_ELECTRON_HEADER,
    createElectronMetricsRouter,
    createElectronMetricsStore,
    validateMetricsSnapshot,
    type MetricsSnapshot,
} from '../../src/manager/routes/electron-metrics.js';

const RENDERER_TOKEN = 'test-renderer-token';
const ORIGINAL_RENDERER_TOKEN = process.env['CLI_JAW_ELECTRON_RENDERER_TOKEN'];
process.env['CLI_JAW_ELECTRON_RENDERER_TOKEN'] = RENDERER_TOKEN;
after(() => {
    if (ORIGINAL_RENDERER_TOKEN === undefined) delete process.env['CLI_JAW_ELECTRON_RENDERER_TOKEN'];
    else process.env['CLI_JAW_ELECTRON_RENDERER_TOKEN'] = ORIGINAL_RENDERER_TOKEN;
});

function sampleSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
    return {
        ts: Date.now(),
        rendererCount: 2,
        mainCount: 1,
        rssTotalKb: 12_345,
        processes: [
            { type: 'Browser', name: 'main', pid: 100, rssKb: 4096, cpu: 1.2 },
            { type: 'Tab', name: 'renderer', pid: 200, rssKb: 8192, cpu: 0.5 },
        ],
        ...overrides,
    };
}

async function withServer(
    fn: (baseUrl: string) => Promise<void>,
    storeTtlMs?: number,
): Promise<void> {
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    const store = createElectronMetricsStore(storeTtlMs);
    app.use(
        '/api/dashboard/electron-metrics',
        createElectronMetricsRouter({ store }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
    }
}

test('GET without electron header reports not-in-electron', async () => {
    await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dashboard/electron-metrics`);
        assert.equal(res.status, 200);
        const body = await res.json() as Record<string, unknown>;
        assert.equal(body.available, false);
        assert.equal(body.reason, 'not-in-electron');
    });
});

test('POST without electron header is rejected with 403', async () => {
    await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dashboard/electron-metrics`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(sampleSnapshot()),
        });
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { ok: false, error: 'desktop renderer only' });
    });
});

test('legacy marker is rejected as renderer identity', async () => {
    await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dashboard/electron-metrics`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [CLI_JAW_ELECTRON_HEADER]: '1' },
            body: JSON.stringify(sampleSnapshot()),
        });
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { ok: false, error: 'desktop renderer only' });
    });
});

test('POST with invalid body is rejected with 400', async () => {
    await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dashboard/electron-metrics`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                [CLI_JAW_ELECTRON_HEADER]: RENDERER_TOKEN,
            },
            body: JSON.stringify({ ts: 'not-a-number' }),
        });
        assert.equal(res.status, 400);
    });
});

test('POST then GET returns the stored snapshot', async () => {
    await withServer(async (baseUrl) => {
        const snap = sampleSnapshot();
        const post = await fetch(`${baseUrl}/api/dashboard/electron-metrics`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                [CLI_JAW_ELECTRON_HEADER]: RENDERER_TOKEN,
            },
            body: JSON.stringify(snap),
        });
        assert.equal(post.status, 200);

        const get = await fetch(`${baseUrl}/api/dashboard/electron-metrics`, {
            headers: { [CLI_JAW_ELECTRON_HEADER]: RENDERER_TOKEN },
        });
        assert.equal(get.status, 200);
        const body = await get.json() as Record<string, unknown>;
        assert.equal(body.available, true);
        const stored = body.snapshot as MetricsSnapshot;
        assert.ok(stored);
        assert.equal(stored.rendererCount, snap.rendererCount);
        assert.equal(stored.processes.length, snap.processes.length);
    });
});

test('GET after TTL expiry returns null snapshot', async () => {
    await withServer(async (baseUrl) => {
        const snap = sampleSnapshot();
        await fetch(`${baseUrl}/api/dashboard/electron-metrics`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                [CLI_JAW_ELECTRON_HEADER]: RENDERER_TOKEN,
            },
            body: JSON.stringify(snap),
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        const get = await fetch(`${baseUrl}/api/dashboard/electron-metrics`, {
            headers: { [CLI_JAW_ELECTRON_HEADER]: RENDERER_TOKEN },
        });
        const body = await get.json() as Record<string, unknown>;
        assert.equal(body.available, true);
        assert.equal(body.snapshot, null);
    }, 25);
});

test('validateMetricsSnapshot rejects malformed processes', () => {
    assert.equal(validateMetricsSnapshot(null), null);
    assert.equal(validateMetricsSnapshot({}), null);
    assert.equal(
        validateMetricsSnapshot({
            ts: 1,
            rendererCount: 1,
            mainCount: 1,
            rssTotalKb: 1,
            processes: [{ type: 'Tab', pid: 'no', rssKb: 0, cpu: 0 }],
        }),
        null,
    );
    const ok = validateMetricsSnapshot({
        ts: 1,
        rendererCount: 1,
        mainCount: 1,
        rssTotalKb: 1,
        processes: [],
    });
    assert.ok(ok);
});
