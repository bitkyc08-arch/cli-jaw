import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createCliStatusCacheForTest, type CliStatusSnapshot } from '../../src/cli/cli-status.ts';
import { runCliStatusWorker } from '../../src/cli/cli-status-worker.ts';
import { CLI_KEYS } from '../../src/cli/registry.ts';

function completedSnapshot(source = 'fixture'): CliStatusSnapshot {
    return Object.fromEntries(CLI_KEYS.map((cli) => [cli, {
        available: true,
        binaryInstalled: true,
        capabilityReady: true,
        authenticated: true,
        path: `/bin/${cli}`,
        source,
        probeState: 'fresh' as const,
    }]));
}

async function nextTurn(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
            if (check()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started >= timeoutMs) {
                clearInterval(timer);
                reject(new Error('condition was not reached'));
            }
        }, 10);
    });
}

test('cold snapshot is registry-only nullable checking and returns before a slow PATH probe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-cli-status-slow-'));
    const which = join(dir, 'which');
    await writeFile(which, '#!/bin/sh\nsleep 1\nexit 1\n');
    await chmod(which, 0o755);
    let refreshSettled = false;
    const cache = createCliStatusCacheForTest({
        refresh: () => runCliStatusWorker({
            timeoutMs: 350,
            env: { ...process.env, PATH: `${dir}${delimiter}${process.env['PATH'] || ''}` },
        }).finally(() => { refreshSettled = true; }),
    });

    let sentinelRan = false;
    setImmediate(() => { sentinelRan = true; });
    const started = performance.now();
    const snapshot = cache.getSnapshot();
    const elapsed = performance.now() - started;

    assert.ok(elapsed < 250, `cold snapshot blocked for ${elapsed.toFixed(1)}ms`);
    assert.deepEqual(Object.keys(snapshot), [...CLI_KEYS]);
    for (const row of Object.values(snapshot)) {
        assert.deepEqual(row, {
            available: null,
            binaryInstalled: null,
            capabilityReady: null,
            authenticated: null,
            path: null,
            source: 'pending-probe',
            probeState: 'checking',
        });
    }
    await nextTurn();
    assert.equal(sentinelRan, true, 'event-loop sentinel must run while worker detection is pending');
    assert.equal(refreshSettled, false, 'slow which probe must remain isolated in the child');
    await waitUntil(() => refreshSettled);
    await rm(dir, { recursive: true, force: true });
});

test('fresh/stale TTL, single-flight, rejection retry, and successful timestamp preservation', async () => {
    let now = 1_000;
    let calls = 0;
    const resolvers: Array<(value: CliStatusSnapshot) => void> = [];
    const rejecters: Array<(error: Error) => void> = [];
    const cache = createCliStatusCacheForTest({
        now: () => now,
        refresh: () => {
            calls += 1;
            return new Promise<CliStatusSnapshot>((resolve, reject) => {
                resolvers.push(resolve);
                rejecters.push(reject);
            });
        },
    });

    assert.equal(cache.getSnapshot()['codex-app']?.probeState, 'checking');
    assert.equal(cache.getSnapshot()['codex-app']?.probeState, 'checking');
    await nextTurn();
    assert.equal(calls, 1);
    resolvers[0]?.(completedSnapshot('first'));
    await nextTurn();

    assert.equal(cache.getSnapshot()['codex-app']?.probeState, 'fresh');
    now += 30_001;
    assert.equal(cache.getSnapshot()['codex-app']?.probeState, 'stale');
    assert.equal(cache.getSnapshot()['codex-app']?.probeState, 'stale');
    await nextTurn();
    assert.equal(calls, 2);
    rejecters[1]?.(new Error('refresh failed'));
    await nextTurn();

    now += 1;
    assert.equal(cache.getSnapshot()['codex-app']?.source, 'first');
    await nextTurn();
    assert.equal(calls, 3, 'request after rejection must start a new worker');
    resolvers[2]?.(completedSnapshot('second'));
    await nextTurn();
    assert.equal(cache.getSnapshot()['codex-app']?.source, 'second');
    assert.equal(cache.getSnapshot()['codex-app']?.probeState, 'fresh');

    now += 5 * 60_000 + 1;
    assert.equal(cache.getSnapshot()['codex-app']?.probeState, 'checking');
});

test('outer timeout kills a non-terminating worker tree and rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-cli-status-hang-'));
    const fixture = join(dir, 'never.mjs');
    const pidFile = join(dir, 'pid');
    await writeFile(fixture, [
        "import { writeFileSync } from 'node:fs';",
        "import { spawn } from 'node:child_process';",
        "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "writeFileSync(process.env.PID_FILE, JSON.stringify([process.pid, descendant.pid]));",
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
    ].join('\n'));

    await assert.rejects(
        runCliStatusWorker({ workerPath: fixture, timeoutMs: 500, env: { ...process.env, PID_FILE: pidFile } }),
        /exceeded 500ms/,
    );
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
    await waitUntil(() => {
        return pids.every((pid) => {
            try { process.kill(pid, 0); return false; }
            catch { return true; }
        });
    });
    await rm(dir, { recursive: true, force: true });
});
