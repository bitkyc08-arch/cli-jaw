import test from 'node:test';
import assert from 'node:assert/strict';
import {
    claimWorker, finishWorker, failWorker,
    claimWorkerReplay, markWorkerReplayed, releaseWorkerReplay,
    listPendingWorkerResults, getActiveWorkers,
} from '../../src/orchestrator/worker-registry.js';

// ─── Helpers ─────────────────────────────────────────
const fakeEmp = (id: string) => ({ id, name: `test-${id}`, cli: 'claude' });

function setupFinishedWorker(id: string): void {
    claimWorker(fakeEmp(id), 'test task');
    finishWorker(id, `result-${id}`);
}

// ─── Tests ───────────────────────────────────────────

test('WRH-001: finished worker result is injected exactly once', () => {
    const id = `wrh1-${Date.now()}`;
    setupFinishedWorker(id);

    // First claim succeeds
    assert.ok(claimWorkerReplay(id), 'first claim should succeed');
    // Second claim fails (already claimed)
    assert.ok(!claimWorkerReplay(id), 'second claim should fail — replay already claimed');

    markWorkerReplayed(id);
    // After marking replayed, claim should also fail
    assert.ok(!claimWorkerReplay(id), 'claim after replayed should fail');
});

test('WRH-002: failed reinjection releases replay claim and leaves replay pending', () => {
    const id = `wrh2-${Date.now()}`;
    setupFinishedWorker(id);

    assert.ok(claimWorkerReplay(id), 'claim should succeed');
    // Simulate failure — release the claim
    releaseWorkerReplay(id);

    // Replay should still be pending and claimable
    const pending = listPendingWorkerResults();
    const found = pending.some(p => p.agentId === id);
    assert.ok(found, 'released replay should remain in pending list');

    // Re-claim should succeed after release
    assert.ok(claimWorkerReplay(id), 're-claim after release should succeed');
    markWorkerReplayed(id);
});

test('WRH-003: replay drain picks up pending results from prior workers', () => {
    const id1 = `wrh3a-${Date.now()}`;
    const id2 = `wrh3b-${Date.now()}`;
    setupFinishedWorker(id1);
    setupFinishedWorker(id2);

    const pending = listPendingWorkerResults();
    const ids = pending.map(p => p.agentId);
    assert.ok(ids.includes(id1), 'worker 1 should be in pending list');
    assert.ok(ids.includes(id2), 'worker 2 should be in pending list');

    // Drain: claim and mark each
    for (const pr of pending) {
        if (pr.agentId === id1 || pr.agentId === id2) {
            assert.ok(claimWorkerReplay(pr.agentId));
            markWorkerReplayed(pr.agentId);
        }
    }

    // Both should be gone from pending
    const after = listPendingWorkerResults();
    assert.ok(!after.some(p => p.agentId === id1), 'worker 1 should no longer be pending');
    assert.ok(!after.some(p => p.agentId === id2), 'worker 2 should no longer be pending');
});
