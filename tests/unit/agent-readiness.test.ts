// ─── Agent-runtime readiness (#471) ───
//
// The incident: /api/health reported healthy for 16 hours while every prompt
// failed before spawn, because health never asked whether the configured CLI
// could be resolved. These tests pin the contract that answers it, and the
// boundaries that keep it from driving a useless restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createAgentReadinessCacheForTest } from '../../src/core/agent-readiness.ts';
import { settings } from '../../src/core/config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const systemSrc = fs.readFileSync(join(__dirname, '../../src/routes/system.ts'), 'utf8');

// Async-aware: an earlier sync-only version restored settings.cli before the
// awaited body finished, so the cache read a CLI the test had already put back.
async function withCli<T>(cli: string | undefined, fn: () => Promise<T> | T): Promise<T> {
    const previous = settings['cli'];
    (settings as Record<string, unknown>)['cli'] = cli;
    try { return await fn(); } finally { (settings as Record<string, unknown>)['cli'] = previous; }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('AR-001: a resolvable CLI reports ready with its path', async () => {
    await withCli('codex-app', async () => {
        const cache = createAgentReadinessCacheForTest({
            probe: () => ({ ready: true, path: '/usr/local/bin/codex' }),
        });

        // First read never blocks, so it cannot already know the answer.
        assert.equal(cache.getSnapshot().state, 'unknown');
        await tick();

        const snapshot = cache.getSnapshot();
        assert.equal(snapshot.ready, true);
        assert.equal(snapshot.state, 'ready');
        assert.equal(snapshot.path, '/usr/local/bin/codex');
        assert.equal(snapshot.cli, 'codex-app');
    });
});

test('AR-002: an unresolvable CLI reports unavailable and carries the reason', async () => {
    await withCli('codex-app', async () => {
        const cache = createAgentReadinessCacheForTest({
            probe: () => ({ ready: false, error: "CLI 'codex-app' could not be resolved: Command failed: where.exe codex" }),
        });
        cache.getSnapshot();
        await tick();

        const snapshot = cache.getSnapshot();
        assert.equal(snapshot.ready, false);
        assert.equal(snapshot.state, 'unavailable');
        assert.match(snapshot.error || '', /where\.exe codex/);
    });
});

test('AR-003: reads are served from cache — the probe does not run per request', async () => {
    await withCli('codex-app', async () => {
        let probes = 0;
        const cache = createAgentReadinessCacheForTest({
            ttlMs: 15_000,
            now: () => 1_000,
            probe: () => { probes += 1; return { ready: true }; },
        });
        cache.getSnapshot();
        await tick();
        for (let i = 0; i < 50; i += 1) cache.getSnapshot();
        await tick();

        // /api/health is a polling route and the real probe is a synchronous
        // 3s-timeout lookup; one probe per poll would block the event loop.
        assert.equal(probes, 1);
    });
});

test('AR-004: a stale snapshot refreshes after the TTL', async () => {
    await withCli('codex-app', async () => {
        let probes = 0;
        let clock = 1_000;
        const cache = createAgentReadinessCacheForTest({
            ttlMs: 15_000,
            now: () => clock,
            probe: () => { probes += 1; return { ready: true }; },
        });
        cache.getSnapshot();
        await tick();
        assert.equal(probes, 1);

        clock += 20_000;
        cache.getSnapshot();
        await tick();
        assert.equal(probes, 2);
    });
});

test('AR-005: switching CLI invalidates immediately rather than serving the old verdict', async () => {
    const cache = createAgentReadinessCacheForTest({
        now: () => 1_000,
        probe: (cli) => (cli === 'codex-app' ? { ready: true } : { ready: false, error: 'nope' }),
    });

    await withCli('codex-app', async () => {
        cache.getSnapshot();
        await tick();
        assert.equal(cache.getSnapshot().ready, true);
    });

    await withCli('claude', async () => {
        // Stale-by-TTL would still be fresh here; answering 'ready' under the
        // new CLI's name would be a wrong answer, not a stale one.
        const immediate = cache.getSnapshot();
        assert.equal(immediate.cli, 'claude');
        assert.equal(immediate.state, 'unknown');
        await tick();
        assert.equal(cache.getSnapshot().state, 'unavailable');
    });
});

test('AR-006: no configured CLI is unknown, not unavailable', async () => {
    await withCli(undefined, () => {
        const cache = createAgentReadinessCacheForTest({ probe: () => ({ ready: true }) });
        const snapshot = cache.getSnapshot();

        // A fresh install has no CLI yet. Reporting 'unavailable' would make
        // /api/ready return 503 and drive a restart that fixes nothing.
        assert.equal(snapshot.state, 'unknown');
        assert.equal(snapshot.cli, null);
        assert.equal(snapshot.ready, false);
    });
});

test('AR-007: a probe that throws is unknown, not unavailable', async () => {
    await withCli('codex-app', async () => {
        const cache = createAgentReadinessCacheForTest({
            probe: () => { throw new Error('probe exploded'); },
        });
        cache.getSnapshot();
        await tick();

        const snapshot = cache.getSnapshot();
        assert.equal(snapshot.state, 'unknown');
        assert.equal(snapshot.ready, false);
        assert.match(snapshot.error || '', /probe exploded/);
    });
});

// ─── Route contract ───

test('AR-010: /api/health keeps ok as a constant and adds agentRuntime', () => {
    const healthBlock = systemSrc.slice(
        systemSrc.indexOf("app.get('/api/health'"),
        systemSrc.indexOf("app.get('/api/ready'"),
    );

    // Docker HEALTHCHECK restarts the container and the manager scan drops the
    // instance when this flips. Readiness must not be expressed here.
    assert.match(healthBlock, /ok:\s*true/);
    assert.ok(healthBlock.includes('agentRuntime: getAgentReadiness()'));
});

test('AR-011: /api/ready returns 503 only for a proven-unavailable runtime', () => {
    const readyBlock = systemSrc.slice(systemSrc.indexOf("app.get('/api/ready'"));

    // The 503 is the machine-consumable part of the contract: a watchdog reads
    // the status code without parsing a body.
    assert.match(readyBlock, /agentRuntime\.state === 'unavailable' \? 503 : 200/);
});
