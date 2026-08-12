import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
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
        checkedCapability: 'spawn-probe',
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
            checkedCapability: 'spawn-probe',
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

// The failure this covers is narrow and easy to miss: the direct command obeys
// SIGTERM, so an escalation that only checks whether the child is still alive
// gives up, while a grandchild that ignores the signal is already an orphan and
// no longer reachable by walking parent PIDs. Aborting on the output cap rather
// than the clock is the path that used to skip escalation entirely.
//
// Running runCommand inside this test process would not prove much: the test
// runner's own timers keep the event loop alive, so a cleanup timer would fire
// even if production could never reach it. The real worker exits the moment its
// last probe settles. So the call happens in its own short-lived process that
// is allowed to end naturally, and the orphan check runs here afterwards.
test('an over-cap command takes its SIGTERM-ignoring descendant down with it', {
    skip: process.platform === 'win32',
}, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-cli-status-cap-'));
    const fixture = join(dir, 'noisy.mjs');
    const driver = join(dir, 'driver.mts');
    const pidFile = join(dir, 'pid');
    const resultFile = join(dir, 'result');
    const worker = resolve(import.meta.dirname, '../../src/cli/cli-status-worker.ts');

    try {
        await writeFile(fixture, [
            "import { writeFileSync } from 'node:fs';",
            "import { spawn } from 'node:child_process';",
            // The descendant only has to outlive its parent; it ignores SIGTERM
            // and never exits on its own.
            "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
            `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, descendant.pid]));`,
            // The direct child exits cleanly on SIGTERM, which is exactly what
            // makes a liveness-guarded escalation return without touching the
            // orphan it left behind.
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => process.stdout.write('y'.repeat(16384)), 5);",
        ].join('\n'));
        await writeFile(driver, [
            `import { writeFileSync } from 'node:fs';`,
            `import { runCommand } from ${JSON.stringify(worker)};`,
            `const r = await runCommand(process.execPath, [${JSON.stringify(fixture)}], 10_000);`,
            `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ timedOut: r.timedOut, outputLimited: r.outputLimited }));`,
        ].join('\n'));

        const driverExit = await new Promise<number | null>((done) => {
            const proc = spawn(process.execPath, ['--import', 'tsx', driver], { stdio: 'ignore' });
            proc.once('exit', (code) => done(code));
        });
        assert.equal(driverExit, 0, 'the driver process must exit on its own');

        const result = JSON.parse(await readFile(resultFile, 'utf8')) as {
            timedOut: boolean; outputLimited: boolean;
        };
        assert.equal(result.outputLimited, true, 'the fixture must trip the output cap, not the timeout');
        assert.equal(result.timedOut, false);

        const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
        const stillAlive = (): number[] => pids.filter((pid) => {
            try { process.kill(pid, 0); return true; }
            catch { return false; }
        });
        // SIGKILL delivery and reaping are not instantaneous on a loaded CI box,
        // so allow a short window. The regression this guards against leaves the
        // orphan running indefinitely, which no amount of waiting resolves.
        await waitUntil(() => stillAlive().length === 0, 2_000).catch(() => {});
        assert.deepEqual(stillAlive(), [], 'the driver must not exit before its process group is gone');
    } finally {
        // A regression leaves live processes behind; the temp dir cleanup alone
        // would strand them for the rest of the run.
        try {
            const leftovers = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
            for (const pid of leftovers) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
            }
        } catch { /* the fixture never got far enough to record pids */ }
        await rm(dir, { recursive: true, force: true });
    }
});
