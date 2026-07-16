import assert from 'node:assert/strict';
import test from 'node:test';
import type { DashboardInstance, DashboardInstanceStatus } from '../../src/manager/types.ts';
import {
    createInstanceLifecycleController,
    type InstanceLifecycleClock,
    type InstanceLifecyclePhase,
    type InstanceLifecycleScheduler,
} from '../../public/dashboard2/src/lifecycle/instance-lifecycle-controller.ts';

interface ScheduledTask {
    at: number;
    callback: () => void;
}

class FakeTime implements InstanceLifecycleClock, InstanceLifecycleScheduler {
    private current = 0;
    private nextId = 0;
    private readonly tasks = new Map<number, ScheduledTask>();

    now(): number { return this.current; }

    setTimeout(callback: () => void, delayMs: number): number {
        const id = ++this.nextId;
        this.tasks.set(id, { at: this.current + delayMs, callback });
        return id;
    }

    clearTimeout(handle: unknown): void {
        this.tasks.delete(handle as number);
    }

    pendingCount(): number { return this.tasks.size; }

    async advance(ms: number): Promise<void> {
        const target = this.current + ms;
        while (true) {
            const next = [...this.tasks.entries()]
                .filter(([, task]) => task.at <= target)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next) break;
            this.tasks.delete(next[0]);
            this.current = next[1].at;
            next[1].callback();
            await flush();
        }
        this.current = target;
        await flush();
    }
}

function dashboardInstance(status: DashboardInstanceStatus, port = 3457): DashboardInstance {
    return {
        port,
        url: `http://127.0.0.1:${port}`,
        status,
        ok: status === 'online',
        version: null,
        uptime: null,
        instanceId: null,
        homeDisplay: null,
        workingDir: null,
        projectDirs: null,
        currentCli: null,
        currentModel: null,
        serviceMode: 'ad-hoc',
        lastCheckedAt: '2026-07-16T00:00:00.000Z',
        healthReason: null,
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

test('converges on an immediate online result and exposes the terminal snapshot', async () => {
    const time = new FakeTime();
    let calls = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => { calls += 1; return dashboardInstance('online'); },
    });

    const result = await controller.start({ port: 3457, expectedState: 'online' });

    assert.equal(calls, 1);
    assert.equal(result.phase, 'online');
    assert.equal(result.attempts, 1);
    assert.equal(controller.getSnapshot(), result);
    assert.equal(time.pendingCount(), 0);
});

test('waits 250ms after a completed attempt before delayed online convergence', async () => {
    const time = new FakeTime();
    const results = [dashboardInstance('unknown'), dashboardInstance('online')];
    let calls = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => results[calls++] ?? dashboardInstance('unknown'),
    });

    const completion = controller.start({ port: 3457, expectedState: 'online' });
    await flush();
    assert.equal(calls, 1);
    await time.advance(249);
    assert.equal(calls, 1);
    await time.advance(1);

    assert.equal((await completion).phase, 'online');
    assert.equal(calls, 2);
});

test('requires an existing exact offline status; null, errors, and unknown keep polling', async () => {
    const time = new FakeTime();
    let calls = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => {
            calls += 1;
            if (calls === 1) return null;
            if (calls === 2) throw new Error('manager unavailable');
            if (calls === 3) return dashboardInstance('unknown');
            return dashboardInstance('offline');
        },
    });

    const completion = controller.start({ port: 3457, expectedState: 'offline' });
    await flush();
    assert.equal(controller.getSnapshot().phase, 'polling');
    await time.advance(250);
    assert.equal(controller.getSnapshot().phase, 'polling');
    assert.equal(controller.getSnapshot().lastError, 'manager unavailable');
    await time.advance(250);
    assert.equal(controller.getSnapshot().phase, 'polling');
    await time.advance(250);

    const result = await completion;
    assert.equal(result.phase, 'offline');
    assert.equal(result.attempts, 4);
    assert.equal(result.instance?.status, 'offline');
});

test('never converges from a snapshot for a different port', async () => {
    const time = new FakeTime();
    let calls = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => {
            calls += 1;
            return calls === 1
                ? dashboardInstance('online', 3458)
                : dashboardInstance('online', 3457);
        },
    });

    const completion = controller.start({ port: 3457, expectedState: 'online' });
    await flush();
    assert.equal(controller.getSnapshot().phase, 'polling');
    await time.advance(250);

    assert.equal((await completion).phase, 'online');
    assert.equal(calls, 2);
});

test('enforces the absolute 10 second deadline and aborts a hanging fetch', async () => {
    const time = new FakeTime();
    const pending = deferred<DashboardInstance | null>();
    let signal!: AbortSignal;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: (_port, options) => { signal = options.signal; return pending.promise; },
    });

    const completion = controller.start({ port: 3457, expectedState: 'online' });
    await flush();
    await time.advance(9_999);
    assert.equal(controller.getSnapshot().phase, 'polling');
    await time.advance(1);

    const result = await completion;
    assert.equal(result.phase, 'timed-out');
    assert.equal(result.attempts, 1);
    assert.equal(signal.aborted, true);
    assert.equal(time.pendingCount(), 0);
});

test('caps the operation at 40 total attempts including the immediate attempt', async () => {
    const time = new FakeTime();
    let calls = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => { calls += 1; return dashboardInstance('unknown'); },
    });

    const completion = controller.start({ port: 3457, expectedState: 'online' });
    await flush();
    await time.advance(9_750);

    const result = await completion;
    assert.equal(result.phase, 'timed-out');
    assert.equal(result.attempts, 40);
    assert.equal(calls, 40);
    assert.equal(time.pendingCount(), 0);
});

test('abort cancels an in-flight fetch and resolves the generation as aborted', async () => {
    const time = new FakeTime();
    const pending = deferred<DashboardInstance | null>();
    let signal!: AbortSignal;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: (_port, options) => { signal = options.signal; return pending.promise; },
    });

    const completion = controller.start({ port: 3457, expectedState: 'online' });
    await flush();
    controller.abort();

    assert.equal((await completion).phase, 'aborted');
    assert.equal(controller.getSnapshot().phase, 'aborted');
    assert.equal(signal.aborted, true);
    assert.equal(time.pendingCount(), 0);
});

test('abort clears a pending delay and prevents any later fetch', async () => {
    const time = new FakeTime();
    let calls = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => { calls += 1; return dashboardInstance('unknown'); },
    });

    const completion = controller.start({ port: 3457, expectedState: 'online' });
    await flush();
    assert.equal(time.pendingCount(), 1);
    controller.abort();
    await time.advance(10_000);

    assert.equal((await completion).phase, 'aborted');
    assert.equal(calls, 1);
    assert.equal(time.pendingCount(), 0);
});

test('coalesces wake hints during delay and fetch without overlapping attempts', async () => {
    const time = new FakeTime();
    const second = deferred<DashboardInstance | null>();
    const third = deferred<DashboardInstance | null>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
                if (calls === 1) return dashboardInstance('unknown');
                if (calls === 2) return await second.promise;
                return await third.promise;
            } finally {
                active -= 1;
            }
        },
    });

    const completion = controller.start({ port: 3457, expectedState: 'online' });
    await flush();
    controller.wake();
    controller.wake();
    controller.wake();
    await flush();
    assert.equal(calls, 2, 'delay wakes once despite duplicate hints');

    controller.wake();
    controller.wake();
    second.resolve(dashboardInstance('unknown'));
    await flush();
    assert.equal(calls, 3, 'in-flight hints schedule one sequential follow-up');
    assert.equal(maxActive, 1);

    third.resolve(dashboardInstance('online'));
    assert.equal((await completion).phase, 'online');
    assert.equal(calls, 3);
});

test('a replacement generation rejects stale fetch completion and snapshot commits', async () => {
    const time = new FakeTime();
    const stale = deferred<DashboardInstance | null>();
    const snapshots: Array<{ generation: number; port: number | null; phase: InstanceLifecyclePhase }> = [];
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: port => port === 3457
            ? stale.promise
            : Promise.resolve(dashboardInstance('online', port)),
        onSnapshot: snapshot => snapshots.push({
            generation: snapshot.generation,
            port: snapshot.port,
            phase: snapshot.phase,
        }),
    });

    const first = controller.start({ port: 3457, expectedState: 'online' });
    await flush();
    const second = controller.start({ port: 3458, expectedState: 'online' });

    assert.equal((await first).phase, 'aborted');
    assert.equal((await second).phase, 'online');
    const countBeforeStale = snapshots.length;
    stale.resolve(dashboardInstance('online', 3457));
    await flush();

    assert.equal(snapshots.length, countBeforeStale);
    assert.equal(controller.getSnapshot().generation, 2);
    assert.equal(controller.getSnapshot().port, 3458);
    assert.equal(controller.getSnapshot().phase, 'online');
});

test('a network error is observable and never satisfies offline convergence', async () => {
    const time = new FakeTime();
    let calls = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => {
            calls += 1;
            if (calls === 1) throw new Error('network down');
            return dashboardInstance('offline');
        },
    });

    const completion = controller.start({ port: 3457, expectedState: 'offline' });
    await flush();
    assert.equal(controller.getSnapshot().phase, 'polling');
    assert.equal(controller.getSnapshot().lastError, 'network down');
    await time.advance(250);

    assert.equal((await completion).phase, 'offline');
    assert.equal(calls, 2);
});

test('a non-retryable API error terminates immediately without spending the poll budget', async () => {
    const time = new FakeTime();
    const terminal = Object.assign(new Error('port out of configured scan range'), { retryable: false });
    let calls = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => { calls += 1; throw terminal; },
        shouldRetryError: error => (error as { retryable?: boolean }).retryable !== false,
    });

    const result = await controller.start({ port: 9999, expectedState: 'online' });

    assert.equal(result.phase, 'error');
    assert.equal(result.lastError, 'port out of configured scan range');
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(time.pendingCount(), 0);
});

test('phase, snapshot, and subscription observers expose hook-friendly updates', async () => {
    const time = new FakeTime();
    const phases: InstanceLifecyclePhase[] = [];
    const attempts: number[] = [];
    let subscriptions = 0;
    const controller = createInstanceLifecycleController({
        clock: time,
        scheduler: time,
        fetchInstance: async () => dashboardInstance('online'),
        onPhase: phase => phases.push(phase),
        onSnapshot: snapshot => attempts.push(snapshot.attempts),
    });
    const unsubscribe = controller.subscribe(() => { subscriptions += 1; });

    await controller.start({ port: 3457, expectedState: 'online' });
    unsubscribe();

    assert.deepEqual(phases, ['polling', 'online']);
    assert.deepEqual(attempts, [0, 1, 1, 1]);
    assert.equal(subscriptions, attempts.length);
});
