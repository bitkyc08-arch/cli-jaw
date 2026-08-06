import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import {
    createRateLimiter,
    createRateLimitMiddleware,
    type RateLimitConfig,
} from '../../src/core/rate-limit.ts';

function testBudgets(browserPoll = 2): RateLimitConfig['budgets'] {
    return {
        cli: { poll: 10, mutate: 10, general: 10 },
        manager: { poll: 10, mutate: 10, general: 10 },
        browser: { poll: browserPoll, mutate: 10, general: 10 },
        lan: { poll: 10, mutate: 10, general: 10 },
        remote: { poll: 10, mutate: 10, general: 10 },
    };
}

async function withServer(
    browserPoll: number,
    fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const app = express();
    const limiter = createRateLimiter({ budgets: testBudgets(browserPoll) });
    app.use(createRateLimitMiddleware({
        authToken: 'secret',
        lanAllowed: () => false,
        isPrivateIp: () => false,
        limiter,
    }));
    app.all('/api/*path', (_req, res) => res.json({ ok: true }));
    app.get('/outside', (_req, res) => res.json({ ok: true }));
    const server: Server = createServer(app);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

async function exhaustBrowser(baseUrl: string): Promise<Response> {
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);
    return fetch(`${baseUrl}/api/status`);
}

test('browser exhaustion returns a real 429 with recovery and cache headers', async () => {
    await withServer(2, async baseUrl => {
        const response = await exhaustBrowser(baseUrl);
        assert.equal(response.status, 429);
        assert.ok(response.headers.get('retry-after'));
        assert.ok(response.headers.get('ratelimit'));
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json() as { error: string; retryAfterSec: number };
        assert.equal(body.error, 'rate_limit');
        assert.ok(body.retryAfterSec > 0);
    });
});

test('Bearer-authenticated CLI traffic survives browser exhaustion for the same IP', async () => {
    await withServer(2, async baseUrl => {
        assert.equal((await exhaustBrowser(baseUrl)).status, 429);
        const response = await fetch(`${baseUrl}/api/status`, {
            headers: { authorization: 'Bearer secret' },
        });
        assert.equal(response.status, 200);
    });
});

test('manager-internal traffic survives browser exhaustion for the same IP', async () => {
    await withServer(2, async baseUrl => {
        assert.equal((await exhaustBrowser(baseUrl)).status, 429);
        const response = await fetch(`${baseUrl}/api/status`, {
            headers: { 'x-jaw-internal': '1' },
        });
        assert.equal(response.status, 200);
    });
});

test('SSE, worker pollers, and non-API paths do not consume rate-limit capacity', async () => {
    await withServer(2, async baseUrl => {
        const exemptPaths = [
            '/api/events',
            '/api/orchestrate/worker-runs/abc',
            '/api/orchestrate/worker/abc',
            '/api/orchestrate/worker-progress/abc',
            '/outside',
        ];
        for (const path of exemptPaths) {
            assert.equal((await fetch(`${baseUrl}${path}`)).status, 200);
        }
        assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/status`)).status, 429);
    });
});

test('repeated 429 responses emit one warning per bucket window', async (t) => {
    const warnings: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    await withServer(1, async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);
        for (let index = 0; index < 4; index++) {
            assert.equal((await fetch(`${baseUrl}/api/status`)).status, 429);
        }
    });
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /^\[rate-limit\] 127\.0\.0\.1 \(browser\) exceeded/);
});
