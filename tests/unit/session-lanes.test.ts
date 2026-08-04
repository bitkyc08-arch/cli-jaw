import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe('SessionLanes', () => {
    it('runs different scopes in parallel up to settings.multiSession.maxConcurrent', async () => {
        const lanes = new SessionLanes(() => 2);
        const a = deferred<void>();
        const b = deferred<void>();
        const starts: string[] = [];
        const pa = lanes.run('A', async () => { starts.push('A'); await a.promise; });
        const pb = lanes.run('B', async () => { starts.push('B'); await b.promise; });
        await Promise.resolve();
        assert.deepEqual(starts, ['A', 'B']);
        assert.deepEqual(lanes.stats(), { active: 2, waiting: 0, sessions: 2, maxConcurrent: 2 });
        a.resolve();
        b.resolve();
        await Promise.all([pa, pb]);
        assert.equal(lanes.stats().active, 0);
    });

    it('serializes the same scope and preserves order after rejection', async () => {
        const lanes = new SessionLanes(() => 2);
        const a1 = deferred<void>();
        const trace: string[] = [];
        const p1 = lanes.run('A', async () => {
            trace.push('A1.start');
            await a1.promise;
            trace.push('A1.end');
            throw new Error('boom');
        });
        const p2 = lanes.run('A', async () => { trace.push('A2.start'); });
        await Promise.resolve();
        assert.deepEqual(trace, ['A1.start']);
        a1.resolve();
        await assert.rejects(p1, /boom/);
        await p2;
        assert.deepEqual(trace, ['A1.start', 'A1.end', 'A2.start']);
        assert.equal(lanes.stats().active, 0);
    });

    it('executes same-scope replay re-entry without deadlocking or taking a second slot', async () => {
        const lanes = new SessionLanes(() => 1);
        const trace: string[] = [];
        await lanes.run('A', async () => {
            trace.push('outer');
            await lanes.run('A', async () => { trace.push('replay'); });
        });
        assert.deepEqual(trace, ['outer', 'replay']);
        assert.equal(lanes.stats().active, 0);
    });

    it('runDetachedTurn does not short-circuit same-scope re-entry and waits behind the tail', async () => {
        const lanes = new SessionLanes(() => 2);
        const release = deferred<void>();
        const trace: string[] = [];
        let detached!: Promise<void>;
        const outer = lanes.run('A', async () => {
            trace.push('outer.start');
            detached = lanes.runDetachedTurn('A', async () => { trace.push('detached.start'); });
            await Promise.resolve();
            trace.push('outer.waiting');
            await release.promise;
            trace.push('outer.end');
        });
        await Promise.resolve();
        assert.deepEqual(trace, ['outer.start', 'outer.waiting']);
        release.resolve();
        await outer;
        await detached;
        assert.deepEqual(trace, ['outer.start', 'outer.waiting', 'outer.end', 'detached.start']);
    });

    it('runDetachedTurn still respects the global maxConcurrent limit', async () => {
        const lanes = new SessionLanes(() => 1);
        const release = deferred<void>();
        const starts: string[] = [];
        const a = lanes.run('A', async () => { starts.push('A'); await release.promise; });
        const b = lanes.runDetachedTurn('B', async () => { starts.push('B'); });
        await Promise.resolve();
        assert.deepEqual(starts, ['A']);
        assert.equal(lanes.stats().waiting, 1);
        release.resolve();
        await Promise.all([a, b]);
        assert.deepEqual(starts, ['A', 'B']);
    });

    it('keeps one-slot fairness A1,B1,A2 without violating A order', async () => {
        const lanes = new SessionLanes(() => 1);
        const gate = deferred<void>();
        const starts: string[] = [];
        const a1 = lanes.run('A', async () => { starts.push('A1'); await gate.promise; });
        const a2 = lanes.run('A', async () => { starts.push('A2'); });
        const b1 = lanes.run('B', async () => { starts.push('B1'); });
        await Promise.resolve();
        assert.deepEqual(starts, ['A1']);
        gate.resolve();
        await Promise.all([a1, a2, b1]);
        assert.deepEqual(starts, ['A1', 'B1', 'A2']);
    });
});
