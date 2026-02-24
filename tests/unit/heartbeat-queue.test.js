import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Standalone queue logic reimplementation for unit testing ───
// Mirrors heartbeat.js pendingJobs + runHeartbeatJob + drainPending
// without importing telegram/config/bus dependencies.

function createHeartbeatQueue() {
    let busy = false;
    const pending = [];
    const log = [];       // execution order log
    const broadcasts = []; // broadcast events

    async function runJob(job) {
        if (busy) {
            if (!pending.some(j => j.id === job.id)) {
                pending.push(job);
                broadcasts.push({ pending: pending.length });
            }
            return;
        }
        busy = true;
        try {
            // Simulate async work
            log.push(job.id);
            if (job.work) await job.work();
        } finally {
            busy = false;
            await drainPending();
        }
    }

    async function drainPending() {
        if (pending.length === 0) return;
        const next = pending.shift();
        broadcasts.push({ pending: pending.length });
        await runJob(next);
    }

    return { runJob, pending, log, broadcasts };
}

test('heartbeat queue: 3 jobs accumulate and drain sequentially', async () => {
    const { runJob, log, broadcasts, pending } = createHeartbeatQueue();

    let resolveFirst;
    const firstBlocks = new Promise(r => { resolveFirst = r; });

    // Job A starts and blocks
    const jobA = { id: 'a', name: 'A', work: () => firstBlocks };
    const jobB = { id: 'b', name: 'B' };
    const jobC = { id: 'c', name: 'C' };

    const runA = runJob(jobA);

    // While A is busy, queue B and C
    await runJob(jobB);
    await runJob(jobC);

    // All 3 should be pending (B and C queued)
    assert.equal(pending.length, 2, 'B and C should be pending');
    assert.equal(log.length, 1, 'Only A should have started');
    assert.equal(log[0], 'a');

    // Release A → drain should run B then C
    resolveFirst();
    await runA;

    assert.deepEqual(log, ['a', 'b', 'c'], 'All 3 jobs should run in order');
    assert.equal(pending.length, 0, 'Queue should be empty');
});

test('heartbeat queue: dedupe prevents same job.id from queuing twice', async () => {
    const { runJob, pending, broadcasts } = createHeartbeatQueue();

    let resolveFirst;
    const firstBlocks = new Promise(r => { resolveFirst = r; });

    const jobA = { id: 'a', name: 'A', work: () => firstBlocks };
    const jobB = { id: 'b', name: 'B' };

    const runA = runJob(jobA);

    // Queue B twice
    await runJob(jobB);
    await runJob(jobB); // should be deduped

    assert.equal(pending.length, 1, 'B should only be queued once');

    resolveFirst();
    await runA;
    assert.equal(pending.length, 0);
});

test('heartbeat queue: 5 different jobs all drain in order', async () => {
    const { runJob, log, pending } = createHeartbeatQueue();

    let resolveFirst;
    const firstBlocks = new Promise(r => { resolveFirst = r; });

    const jobs = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id.toUpperCase() }));
    jobs[0].work = () => firstBlocks;

    const runA = runJob(jobs[0]);

    // Queue 4 more while A is running
    for (let i = 1; i < 5; i++) {
        await runJob(jobs[i]);
    }

    assert.equal(pending.length, 4, '4 jobs should be pending');

    resolveFirst();
    await runA;

    assert.deepEqual(log, ['a', 'b', 'c', 'd', 'e'], 'All 5 jobs drain in FIFO order');
    assert.equal(pending.length, 0);
});

test('heartbeat queue: broadcasts pending count on queue and dequeue', async () => {
    const { runJob, broadcasts } = createHeartbeatQueue();

    let resolveFirst;
    const firstBlocks = new Promise(r => { resolveFirst = r; });

    const jobA = { id: 'a', name: 'A', work: () => firstBlocks };
    const runA = runJob(jobA);

    await runJob({ id: 'b', name: 'B' });
    await runJob({ id: 'c', name: 'C' });
    await runJob({ id: 'd', name: 'D' });

    // 3 queue broadcasts: pending=1, pending=2, pending=3
    assert.deepEqual(
        broadcasts.slice(0, 3).map(b => b.pending),
        [1, 2, 3],
        'Queue broadcasts should show increasing pending count'
    );

    resolveFirst();
    await runA;

    // Drain broadcasts: pending=2, pending=1, pending=0
    assert.deepEqual(
        broadcasts.slice(3).map(b => b.pending),
        [2, 1, 0],
        'Drain broadcasts should show decreasing pending count'
    );
});
