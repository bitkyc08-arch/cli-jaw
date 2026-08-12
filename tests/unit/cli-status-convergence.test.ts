import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createCliStatusCacheForTest,
    type CliStatusSnapshot,
} from '../../src/cli/cli-status.ts';
import { collectCliStatus } from '../../src/cli/cli-status-worker.ts';
import { CLI_KEYS } from '../../src/cli/registry.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { CliProbeNotice } from '../../public/manager/src/settings/pages/Agent.tsx';
import { describeCliProbeAvailability } from '../../public/js/features/settings-types.ts';

const firstCli = CLI_KEYS[0]!;

function successfulSnapshot(): CliStatusSnapshot {
    return Object.fromEntries(CLI_KEYS.map((cli) => [cli, {
        available: true,
        binaryInstalled: true,
        capabilityReady: true,
        authenticated: true,
        path: `/bin/${cli}`,
        source: 'fixture',
        checkedCapability: 'spawn-probe',
        probeState: 'fresh' as const,
    }]));
}

async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test('successful probe converges to fresh and names the checked capability', async () => {
    const cache = createCliStatusCacheForTest({ refresh: async () => successfulSnapshot() });
    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'checking');
    await settle();

    const row = cache.getSnapshot()[firstCli]!;
    assert.equal(row.probeState, 'fresh');
    assert.equal(row.checkedCapability, 'spawn-probe');
});

test('probe error converges to failing with probeError', async () => {
    const cache = createCliStatusCacheForTest({
        refresh: async () => { throw new Error('spawn probe failed'); },
    });
    cache.getSnapshot();
    await settle();

    const row = cache.getSnapshot()[firstCli]!;
    assert.equal(row.probeState, 'failing');
    assert.equal(row.probeError, 'spawn probe failed');
});

test('a probe that cannot run is unknown rather than missing', async () => {
    const cache = createCliStatusCacheForTest({
        refresh: () => collectCliStatus({
            detectAll: () => ({
                [firstCli]: {
                    available: false,
                    path: null,
                    scanError: 'lookup tool where.exe could not run',
                },
            }),
        }),
    });
    cache.getSnapshot();
    await settle();

    const row = cache.getSnapshot()[firstCli]!;
    assert.equal(row.probeState, 'unknown');
    assert.equal(row.probeError, 'lookup tool where.exe could not run');
    assert.equal(row.checkedCapability, 'spawn-probe');
    assert.equal(row.available, null);

    const presentation = describeCliProbeAvailability(row);
    assert.deepEqual(presentation, {
        kind: 'unknown',
        message: 'Probe unavailable: lookup tool where.exe could not run',
        allowRemediation: false,
    });

    const html = renderToStaticMarkup(createElement(CliProbeNotice, { status: row }));
    assert.match(html, /Probe unavailable/);
    assert.match(html, /lookup tool where\.exe could not run/);
    assert.doesNotMatch(html, /install|login|auth/i);
});

test('stale is emitted only after a fresh result decays', async () => {
    let now = 1_000;
    const neverSettles = new Promise<CliStatusSnapshot>(() => {});
    let first = true;
    const cache = createCliStatusCacheForTest({
        now: () => now,
        freshTtlMs: 10,
        staleTtlMs: 100,
        refresh: () => {
            if (first) {
                first = false;
                return Promise.resolve(successfulSnapshot());
            }
            return neverSettles;
        },
    });

    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'checking');
    await settle();
    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'fresh');

    now += 11;
    assert.equal(cache.getSnapshot()[firstCli]!.probeState, 'stale');

    const cold = createCliStatusCacheForTest({
        now: () => now,
        freshTtlMs: 10,
        staleTtlMs: 100,
        refresh: () => neverSettles,
    });
    now += 1_000;
    assert.equal(cold.getSnapshot()[firstCli]!.probeState, 'checking');
});
