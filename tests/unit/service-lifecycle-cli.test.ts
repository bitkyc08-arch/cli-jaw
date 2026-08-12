import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    nativeOutcome,
    resolveControlNative,
    runServiceLifecycle,
    type ServiceLifecycleDeps,
    type ServiceLifecycleOutcome,
} from '../../bin/commands/service.js';
import type { OwnershipVerdict, PidfileRecord } from '../../src/core/instance-lifecycle.js';
import type { DashboardLifecycleResult, DashboardServiceState } from '../../src/manager/types.js';

const record: PidfileRecord = {
    pid: 1234, startedAt: { value: '99', source: 'linux-proc' }, port: 3457, home: '/jaw/home', version: '2.2.18',
};
const owned: OwnershipVerdict = { status: 'owned', record };

test('SLC-000: the root CLI dispatches service lifecycle commands', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-jaw-service-dispatch-'));
    try {
        const output = execFileSync(process.execPath, [
            '--import', 'tsx',
            'bin/cli-jaw.ts', '--home', home,
            'service', 'stop', '--port', '65534',
        ], { encoding: 'utf8' });
        assert.match(output, /no pidfile exists for this home/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

function lifecycle(overrides: Partial<ServiceLifecycleDeps> = {}): ServiceLifecycleDeps {
    return {
        verifyOwnership: () => owned,
        verifyAndSignal: () => 'signalled',
        waitForExit: async () => true,
        ...overrides,
    };
}

test('SLC-001: stop signals only an owned pid', async () => {
    const signals: NodeJS.Signals[] = [];
    const result = await runServiceLifecycle('stop', lifecycle({ verifyAndSignal: signal => { signals.push(signal); return 'signalled'; } }));
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(result.status, 'stopped');
});

for (const [name, verdict] of [
    ['SLC-002: stop never signals a stale record', { status: 'stale', record, reason: 'recycled' }],
    ['SLC-003: stop never signals a foreign record', { status: 'foreign', record, reason: 'home mismatch' }],
    ['SLC-004: permission-denied is reported, not retried', { status: 'permission-denied', record }],
    ['SLC-004b: unverifiable never signals', { status: 'unverifiable', record, reason: 'OS start time unavailable' }],
] as const) {
    test(name, async () => {
        let signalled = false;
        const result = await runServiceLifecycle('stop', lifecycle({
            verifyOwnership: () => verdict,
            verifyAndSignal: () => { signalled = true; return 'signalled'; },
        }));
        assert.equal(result.status, verdict.status);
        assert.equal(signalled, false);
    });
}

test('SLC-004c: a change detected at the final check does not signal', async () => {
    assert.equal((await runServiceLifecycle('stop', lifecycle({ verifyAndSignal: () => 'raced' }))).status, 'raced');
});

test('SLC-004d: a final-check ownership denial maps to stale', async () => {
    assert.equal((await runServiceLifecycle('stop', lifecycle({ verifyAndSignal: () => 'not-owned' }))).status, 'stale');
});

test('SLC-005: a native stop delegates instead of signalling', async () => {
    const actions: string[] = [];
    let signalled = false;
    const native = async (action: 'stop' | 'restart'): Promise<ServiceLifecycleOutcome> => {
        actions.push(action); return { action, status: 'stopped', message: 'native' };
    };
    await runServiceLifecycle('stop', lifecycle({ controlNative: native, verifyAndSignal: () => { signalled = true; return 'signalled'; } }));
    assert.deepEqual(actions, ['stop']);
    assert.equal(signalled, false);
});

test('SLC-005b: a native restart delegates AS restart', async () => {
    const actions: string[] = [];
    await runServiceLifecycle('restart', lifecycle({ controlNative: async action => {
        actions.push(action); return { action, status: 'stopped', message: 'native' };
    } }));
    assert.deepEqual(actions, ['restart']);
});

function nativeResult(ok: boolean, action: 'stop' | 'restart' = 'stop'): DashboardLifecycleResult {
    return { ok, action, port: 3457, status: ok ? 'stopped' : 'rejected', message: ok ? 'native ok' : 'bootout failed: denied', home: record.home, pid: record.pid, command: [] };
}

test('SLC-005c: a refused native action converts to foreign', () => {
    const result = nativeOutcome('stop', nativeResult(false));
    assert.equal(result.status, 'foreign');
    assert.equal(result.message, 'bootout failed: denied');
});

test('SLC-005d: a successful native action converts to stopped', () => {
    const result = nativeOutcome('restart', nativeResult(true, 'restart'));
    assert.equal(result.status, 'stopped');
    assert.equal(result.action, 'restart');
});

function serviceState(registered: boolean): DashboardServiceState {
    return { registered, loaded: registered, pid: registered ? record.pid : null, label: registered ? 'com.cli-jaw.3457' : '', unitPath: '', backend: 'launchd' };
}

test('SLC-005e: a service backend that exists but is NOT registered yields no native control', async () => {
    let stopped = false;
    const control = await resolveControlNative(3457, record.home, {
        detectServiceState: async () => serviceState(false),
        stopServiceInstance: async () => { stopped = true; return nativeResult(true); },
        restartServiceInstance: async () => nativeResult(true, 'restart'),
    });
    assert.equal(control, null);
    assert.equal(stopped, false);
});

test('SLC-005f: a registered instance yields native control bound to its label', async () => {
    const labels: string[] = [];
    const control = await resolveControlNative(3457, record.home, {
        detectServiceState: async () => serviceState(true),
        stopServiceInstance: async label => { labels.push(label); return nativeResult(true); },
        restartServiceInstance: async () => nativeResult(true, 'restart'),
    });
    assert.ok(control);
    await control('stop');
    assert.deepEqual(labels, ['com.cli-jaw.3457']);
});

test('SLC-006: restart starts only after exit is observed', async () => {
    const order: string[] = [];
    await runServiceLifecycle('restart', lifecycle({
        waitForExit: async () => { order.push('exit'); return true; },
        startInstance: async () => { order.push('start'); },
    }));
    assert.deepEqual(order, ['exit', 'start']);
});

test('SLC-007: restart that never exits reports timeout', async () => {
    let started = false;
    const result = await runServiceLifecycle('restart', lifecycle({
        waitForExit: async () => false,
        startInstance: async () => { started = true; },
    }));
    assert.equal(result.status, 'timeout');
    assert.equal(started, false);
});
