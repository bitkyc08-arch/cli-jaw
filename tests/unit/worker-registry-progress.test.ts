import test from 'node:test';
import assert from 'node:assert/strict';
import {
    claimWorker,
    clearAllWorkers,
    finishWorker,
    getWorkerSlot,
    getWorkerProgressSnapshot,
    listPendingWorkerResults,
    markWorkerActive,
    markWorkerDisconnected,
    markWorkerReplayed,
    markWorkerStalled,
    markWorkerTimedOut,
    updateWorkerTools,
} from '../../src/orchestrator/worker-registry.ts';

test.afterEach(() => {
    clearAllWorkers();
});

test('worker registry stores readable employee tool progress while running', () => {
    claimWorker({ id: 'backend', name: 'Backend' }, 'verify build');
    updateWorkerTools('backend', [{
        icon: '🔧',
        label: "/bin/zsh -lc 'npm run typecheck'",
        toolType: 'tool',
        status: 'running',
    }]);

    const slot = getWorkerSlot('backend');
    assert.equal(slot?.tools.length, 1);
    assert.equal(slot?.tools[0]?.label, 'npm run typecheck');
    assert.equal(slot?.progressUpdatedAt && slot.progressUpdatedAt > 0, true);

    const progress = getWorkerProgressSnapshot('backend');
    assert.equal(progress?.current?.tools[0]?.label, 'npm run typecheck');
    assert.equal(progress?.previous, null);
});

test('pending worker replay includes final employee tool process', () => {
    claimWorker({ id: 'backend', name: 'Backend' }, 'verify build');
    finishWorker('backend', 'done', [{
        icon: '⚡',
        label: "/bin/zsh -lc 'npm run build'",
        toolType: 'tool',
        status: 'done',
    }]);

    const pending = listPendingWorkerResults();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.text, 'done');
    assert.equal(pending[0]?.tools?.[0]?.label, 'npm run build');
});

test('previous completed progress survives replay cleanup', () => {
    claimWorker({ id: 'backend', name: 'Backend' }, 'verify build');
    finishWorker('backend', 'done', [{
        icon: '⚡',
        label: "/bin/zsh -lc 'npm run build'",
        detail: "/bin/zsh -lc 'npm run build'",
        toolType: 'tool',
        status: 'done',
    }]);

    markWorkerReplayed('backend');

    const slot = getWorkerSlot('backend');
    const progress = getWorkerProgressSnapshot('backend');
    assert.equal(slot, undefined);
    assert.equal(progress?.current, null);
    assert.equal(progress?.previous?.state, 'done');
    assert.equal(progress?.previous?.tools[0]?.label, 'npm run build');
});

test('worker registry progress omits thinking rows', () => {
    claimWorker({ id: 'backend', name: 'Backend' }, 'verify build');
    updateWorkerTools('backend', [{
        icon: '💭',
        label: 'private reasoning',
        detail: 'hidden',
        toolType: 'thinking',
    }, {
        icon: '🔧',
        label: 'Read path',
        detail: 'Read path',
        toolType: 'tool',
    }]);

    const progress = getWorkerProgressSnapshot('backend');
    assert.equal(progress?.current?.tools.length, 1);
    assert.equal(progress?.current?.tools[0]?.label, 'Read path');
});

test('worker registry exposes lifecycle attention in progress snapshots', () => {
    claimWorker({ id: 'backend', name: 'Backend' }, 'verify build');
    markWorkerStalled('backend');
    assert.equal(getWorkerProgressSnapshot('backend')?.current?.attention?.kind, 'stalled');

    markWorkerActive('backend');
    assert.equal(getWorkerProgressSnapshot('backend')?.current?.attention, undefined);

    markWorkerDisconnected('backend', 1);
    const disconnected = getWorkerProgressSnapshot('backend')?.current?.attention;
    assert.equal(disconnected?.kind, 'disconnected');
    assert.equal(disconnected?.exitCode, 1);
});

test('worker registry exposes timeout and pending replay attention', () => {
    claimWorker({ id: 'backend', name: 'Backend' }, 'verify build');
    markWorkerTimedOut('backend');
    assert.equal(getWorkerProgressSnapshot('backend')?.current?.attention?.kind, 'timeout');
});

test('worker registry exposes pending replay attention', () => {
    claimWorker({ id: 'backend', name: 'Backend' }, 'verify build');
    finishWorker('backend', 'done');
    const progress = getWorkerProgressSnapshot('backend');
    assert.equal(progress?.previous?.attention?.kind, 'pending_replay');
    assert.equal(progress?.previous?.attention?.attempts, 0);
});
