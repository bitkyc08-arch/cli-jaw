import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cliStatusBackoffMs,
    createCliStatusCacheForTest,
    formatCliStatusLine,
    type CliStatusSnapshot,
} from '../../src/cli/cli-status.ts';
import { CLI_KEYS } from '../../src/cli/registry.ts';

// #277: /api/cli-status never converged on Windows — every runtime reported
// checking and then stale, forever, for a runtime that demonstrably worked.
// The cause was a catch that discarded the worker error entirely, so a probe
// that kept failing was indistinguishable from one still in progress, and the
// reason was never exposed to anyone.

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

const firstCli = CLI_KEYS[0]!;

test('a failing probe reports failing with its reason, not an indefinite stale', async () => {
    let now = 1_000;
    const cache = createCliStatusCacheForTest({
        now: () => now,
        refresh: () => Promise.reject(new Error('worker exited with code 1')),
    });

    cache.getSnapshot();
    await nextTurn();

    const row = cache.getSnapshot()[firstCli]!;
    assert.equal(row.probeState, 'failing');
    assert.equal(row.probeError, 'worker exited with code 1');
    assert.equal(row.probeFailures, 1);
});

test('the first retry is still immediate, preserving the existing contract', async () => {
    let now = 1_000;
    let calls = 0;
    const cache = createCliStatusCacheForTest({
        now: () => now,
        refresh: () => { calls += 1; return Promise.reject(new Error('boom')); },
    });

    cache.getSnapshot();
    await nextTurn();
    assert.equal(calls, 1);

    // A request after a rejection must start a new worker — cli-status-cache
    // pins this, so the backoff cannot begin before the second failure.
    now += 1;
    cache.getSnapshot();
    await nextTurn();
    assert.equal(calls, 2, 'request after the first rejection must start a new worker');
});

test('repeated failures back off instead of respawning a worker per read', async () => {
    let now = 1_000;
    let calls = 0;
    const cache = createCliStatusCacheForTest({
        now: () => now,
        refresh: () => { calls += 1; return Promise.reject(new Error('boom')); },
    });

    cache.getSnapshot(); await nextTurn();   // failure 1 -> backoff 0
    now += 1;
    cache.getSnapshot(); await nextTurn();   // failure 2 -> backoff starts
    const afterSecond = calls;

    const row = cache.getSnapshot()[firstCli]!;
    assert.ok(row.nextRetryAt! > now, 'a second failure must schedule a future retry');

    // Reads inside the backoff window must not spawn anything.
    now += 1;
    cache.getSnapshot(); await nextTurn();
    cache.getSnapshot(); await nextTurn();
    assert.equal(calls, afterSecond, 'reads inside the backoff window must not respawn');

    // Once the window expires, probing resumes.
    now = row.nextRetryAt!;
    cache.getSnapshot(); await nextTurn();
    assert.equal(calls, afterSecond + 1, 'probing must resume after the backoff expires');
});

test('recovery clears the failure and returns to fresh', async () => {
    let now = 1_000;
    let shouldFail = true;
    const cache = createCliStatusCacheForTest({
        now: () => now,
        refresh: () => (shouldFail
            ? Promise.reject(new Error('boom'))
            : Promise.resolve(completedSnapshot())),
    });

    cache.getSnapshot(); await nextTurn();
    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'failing');

    shouldFail = false;
    now += 1;
    cache.getSnapshot(); await nextTurn();

    const row = cache.getSnapshot()[firstCli]!;
    assert.equal(row.probeState, 'fresh');
    assert.equal(row.probeError, undefined);
});

test('a failure after a success outranks the preserved snapshot', async () => {
    let now = 1_000;
    let shouldFail = false;
    const cache = createCliStatusCacheForTest({
        now: () => now,
        refresh: () => (shouldFail
            ? Promise.reject(new Error('probe died'))
            : Promise.resolve(completedSnapshot())),
    });

    cache.getSnapshot(); await nextTurn();
    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'fresh');

    // This is the exact #277 shape: a good snapshot goes stale while every
    // subsequent probe fails. Reporting `stale` here hides the real problem.
    shouldFail = true;
    now += 31_000;
    cache.getSnapshot(); await nextTurn();

    const row = cache.getSnapshot()[firstCli]!;
    assert.equal(row.probeState, 'failing');
    assert.equal(row.probeError, 'probe died');
});

test('backoff is 0 first, then exponential, and capped', () => {
    assert.equal(cliStatusBackoffMs(1), 0);
    assert.equal(cliStatusBackoffMs(2), 15_000);
    assert.equal(cliStatusBackoffMs(3), 30_000);
    assert.equal(cliStatusBackoffMs(99), 5 * 60_000);
});

test('a forced read bypasses the backoff window', async () => {
    // Retries are demand-driven with no timer, so a user who fixes the problem
    // would otherwise wait out the full backoff even after hitting Refresh.
    let now = 1_000;
    let calls = 0;
    const cache = createCliStatusCacheForTest({
        now: () => now,
        refresh: () => { calls += 1; return Promise.reject(new Error('boom')); },
    });

    cache.getSnapshot(); await nextTurn();   // failure 1 -> immediate retry allowed
    now += 1;
    cache.getSnapshot(); await nextTurn();   // failure 2 -> backoff begins
    const backedOff = calls;

    now += 1;
    cache.getSnapshot(); await nextTurn();
    assert.equal(calls, backedOff, 'a normal read inside the window must not respawn');

    cache.getSnapshot(true); await nextTurn();
    assert.equal(calls, backedOff + 1, 'a forced read must probe immediately');
});

test('a clock rollback cannot resurrect a stale success over a recorded failure', async () => {
    let now = 100_000;
    let shouldFail = false;
    const cache = createCliStatusCacheForTest({
        now: () => now,
        refresh: () => (shouldFail
            ? Promise.reject(new Error('probe died'))
            : Promise.resolve(completedSnapshot())),
    });

    cache.getSnapshot(); await nextTurn();
    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'fresh');

    shouldFail = true;
    now += 31_000;
    cache.getSnapshot(); await nextTurn();
    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'failing');

    // Date.now() is not monotonic. A correction that moves the clock backwards
    // must not make the last success look fresh again.
    now -= 31_000;
    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'failing');
});

test('the CLI formatter never prints a green check while probes are failing', () => {
    // A preserved snapshot still carries available:true, so without an explicit
    // branch `jaw /version` style output would report the runtime as ready.
    const line = formatCliStatusLine('codex-app', {
        available: true,
        capabilityReady: true,
        probeState: 'failing',
        path: '/bin/codex',
        probeError: 'worker timeout',
    });
    assert.ok(!line.includes('✅'), `must not claim ready: ${line}`);
    assert.match(line, /probe failing/);
    assert.match(line, /worker timeout/);
});

test('/version does not collapse failing into fresh', async () => {
    // handlers.ts narrows probeState before formatting. Its original allowlist
    // was checking|stale with everything else mapped to fresh, which would have
    // printed a green check for a failing probe and silently undone this fix.
    const { versionHandler } = await import('../../src/cli/handlers.ts');
    const result = await versionHandler([], {
        version: '0.0.0-test',
        getCliStatus: () => Promise.resolve({
            'codex-app': {
                available: true,
                capabilityReady: true,
                probeState: 'failing',
                probeError: 'spawn worker ENOENT',
                path: '/bin/codex',
            },
        }),
    } as never);

    assert.ok(result.text, 'version output should exist');
    const codexLine = result.text!.split('\n').find((l) => l.startsWith('codex-app:'));
    assert.ok(codexLine, 'codex-app line should be present');
    assert.ok(!codexLine!.includes('✅'), `must not claim ready: ${codexLine}`);
    assert.match(codexLine!, /probe failing/);
    assert.match(codexLine!, /spawn worker ENOENT/);
});
