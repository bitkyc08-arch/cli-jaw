import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

type Deferred<T = void> = {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
};

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

type FakeOptions = {
    binary?: string;
    workDir?: string;
    env?: NodeJS.ProcessEnv;
    model?: string;
    effort?: string;
    fastMode?: boolean;
};
type TurnHandler = {
    role?: string;
    onNotification(method: string, params: Record<string, unknown>, owner?: {
        threadId: string; turnId: string | null;
    }): void;
    onInterruptFailed?(error: Error): void;
};

const fakeState: {
    instances: FakeCodexAppClient[];
    nextInitialize: Promise<void> | null;
    nextThread: number;
} = { instances: [], nextInitialize: null, nextThread: 1 };

class FakeCodexAppClient extends EventEmitter {
    readonly options: FakeOptions;
    readonly threads = new Map<string, string>();
    readonly activeTurns = new Map<string, string>();
    readonly listenersByScope = new Map<string, Set<TurnHandler>>();
    readonly startCalls: Array<{ scope: string; options: unknown }> = [];
    readonly resumeCalls: Array<{ scope: string; threadId: string; options: unknown }> = [];
    readonly interruptCalls: string[] = [];
    readonly closeScopeCalls: string[] = [];
    readonly listenRoles: Array<{ scope: string; role: string | undefined }> = [];
    proc = { exitCode: null as number | null, killed: false, pid: 50_000 + fakeState.instances.length };
    initializeCount = 0;
    closeGracefullyCount = 0;
    killCount = 0;
    closeScopeGate: Deferred | null = null;
    closeScopeError: Error | null = null;
    closeGracefullyGate: Deferred | null = null;
    interruptError: Error | null = null;

    constructor(options: FakeOptions = {}) {
        super();
        this.options = options;
        fakeState.instances.push(this);
    }

    spawn(): void {}

    async initialize(): Promise<void> {
        this.initializeCount += 1;
        if (fakeState.nextInitialize) await fakeState.nextInitialize;
    }

    getThreadId(scope: string): string | null { return this.threads.get(scope) ?? null; }
    getActiveTurnId(scope: string): string | null { return this.activeTurns.get(scope) ?? null; }

    listenTurn(scope: string, handler: TurnHandler): { dispose(): void } {
        this.listenRoles.push({ scope, role: handler.role });
        const handlers = this.listenersByScope.get(scope) ?? new Set<TurnHandler>();
        handlers.add(handler);
        this.listenersByScope.set(scope, handlers);
        return { dispose: () => {
            handlers.delete(handler);
            if (handlers.size === 0) this.listenersByScope.delete(scope);
        } };
    }

    async startThread(scope: string, options: unknown): Promise<string> {
        this.startCalls.push({ scope, options });
        const threadId = `thread-${fakeState.nextThread++}`;
        this.threads.set(scope, threadId);
        return threadId;
    }

    async resumeThread(scope: string, threadId: string, options: unknown): Promise<string> {
        this.resumeCalls.push({ scope, threadId, options });
        if (threadId.startsWith('missing-')) throw new Error(`no rollout found for thread id ${threadId}`);
        this.threads.set(scope, threadId);
        return threadId;
    }

    async interruptTurn(scope: string): Promise<void> {
        this.interruptCalls.push(scope);
        if (this.interruptError) throw this.interruptError;
    }

    async closeScope(scope: string): Promise<void> {
        this.closeScopeCalls.push(scope);
        if (this.closeScopeGate) await this.closeScopeGate.promise;
        if (this.activeTurns.has(scope)) throw new Error(`Cannot close active scope ${scope}`);
        if (this.closeScopeError) throw this.closeScopeError;
        this.threads.delete(scope);
    }

    async closeGracefully(): Promise<void> {
        this.closeGracefullyCount += 1;
        if (this.closeGracefullyGate) await this.closeGracefullyGate.promise;
        this.proc.killed = true;
    }

    kill(): void { this.killCount += 1; this.proc.killed = true; }

    setActive(scope: string, turnId = `turn-${scope}`): void { this.activeTurns.set(scope, turnId); }

    complete(scope: string): void {
        const turnId = this.activeTurns.get(scope);
        const threadId = this.threads.get(scope);
        if (!turnId || !threadId) throw new Error(`No active fake turn for ${scope}`);
        for (const handler of [...(this.listenersByScope.get(scope) ?? [])]) {
            handler.onNotification(
                'turn/completed', { threadId, turn: { id: turnId } }, { threadId, turnId },
            );
        }
        this.activeTurns.delete(scope);
    }

    failInterrupt(scope: string, error: Error): void {
        for (const handler of [...(this.listenersByScope.get(scope) ?? [])]) {
            handler.onInterruptFailed?.(error);
        }
    }

    die(): void {
        this.proc.exitCode = 1;
        this.emit('exit', 1, null);
        this.removeAllListeners();
    }
}

mock.module('../../src/agent/codex-app-client.js', {
    namedExports: {
        CodexAppClient: FakeCodexAppClient,
        isRecoverableResumeError: (message: string) => /not found|no rollout found|unknown thread/i.test(message),
    },
});

mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });

const pool = await import('../../src/agent/codex-host-pool.js');

let identity = 1;
function prepareOptions(overrides: Partial<{
    binary: string; cwd: string; fastMode: boolean; env: NodeJS.ProcessEnv; model: string; effort: string;
}> = {}) {
    return {
        binary: overrides.binary ?? '/fake/codex',
        cwd: overrides.cwd ?? '/tmp',
        fastMode: overrides.fastMode ?? false,
        env: overrides.env ?? { PATH: '/bin', HOST_POOL_TEST: 'same' },
        model: overrides.model ?? `model-${identity++}`,
        effort: overrides.effort ?? 'high',
    };
}

function bucket(scope: string, model: string, effort = 'high'): string {
    return `codex-app:${scope}:${model}:${effort}`;
}

function clientAt(index: number): FakeCodexAppClient {
    const client = fakeState.instances[index];
    assert.ok(client);
    return client;
}

async function flush(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function tick(ms: number): Promise<void> {
    mock.timers.tick(ms);
    await flush();
}

async function prepareFor(model: string, scope?: string) {
    const prepared = await pool.prepareCodexAppHost(prepareOptions({ model }));
    if (!scope) return { prepared };
    const lease = await pool.acquireCodexAppLane(prepared, {
        scopeKey: scope, bucketKey: bucket(scope, model),
    });
    return { prepared, lease, client: lease.client as unknown as FakeCodexAppClient };
}

test('concurrent prepare is single-flight, tokens are distinct, and env snapshot is constructor-identical', async () => {
    const gate = deferred();
    fakeState.nextInitialize = gate.promise;
    const env: NodeJS.ProcessEnv = { PATH: '/bin', SNAPSHOT_VALUE: 'before', OMITTED_VALUE: undefined };
    const options = prepareOptions({ model: 'single-flight', env });
    const before = fakeState.instances.length;
    const firstPromise = pool.prepareCodexAppHost(options);
    const secondPromise = pool.prepareCodexAppHost(options);
    await flush();
    assert.equal(fakeState.instances.length, before + 1);
    const client = clientAt(before);
    env['SNAPSHOT_VALUE'] = 'after';
    gate.resolve();
    fakeState.nextInitialize = null;
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.notEqual(first, second);
    assert.equal(client.options.env?.['SNAPSHOT_VALUE'], 'before');
    assert.equal(Object.hasOwn(client.options.env ?? {}, 'OMITTED_VALUE'), false);
    assert.equal(Object.isFrozen(client.options.env), true);

    const firstLease = await pool.acquireCodexAppLane(first, {
        scopeKey: 'scope-a', bucketKey: bucket('scope-a', 'single-flight'), instructions: 'A',
    });
    const secondLease = await pool.acquireCodexAppLane(second, {
        scopeKey: 'scope-b', bucketKey: bucket('scope-b', 'single-flight'),
    });
    assert.equal(firstLease.client, secondLease.client);
    assert.equal(firstLease.scopeKey, 'scope-a');
    assert.equal(firstLease.laneScope, 'scope-a:single-flight:high');
    assert.deepEqual(client.startCalls.map((call) => call.scope), [
        'scope-a:single-flight:high', 'scope-b:single-flight:high',
    ]);
    firstLease.release(); secondLease.release(); client.die();
});

test('env and fastMode differences split hosts', async () => {
    const before = fakeState.instances.length;
    const base = prepareOptions({ model: 'host-split', env: { PATH: '/bin', VALUE: 'a' } });
    await pool.prepareCodexAppHost(base);
    await pool.prepareCodexAppHost({ ...base, env: { PATH: '/bin', VALUE: 'b' } });
    await pool.prepareCodexAppHost({ ...base, fastMode: true });
    assert.equal(fakeState.instances.length, before + 3);
    for (let index = before; index < before + 3; index += 1) clientAt(index).die();
});

test('token is consumed and bucket identity is rejected before any RPC or lane creation', async () => {
    const model = 'token-once';
    const before = fakeState.instances.length;
    const prepared = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const client = clientAt(before);
    assert.throws(() => pool.acquireCodexAppLane(prepared, {
        scopeKey: 'scope-token', bucketKey: 'codex-app:wrong',
    }), pool.CodexHostGenerationStaleError);
    assert.throws(() => pool.acquireCodexAppLane(prepared, {
        scopeKey: 'scope-token', bucketKey: bucket('scope-token', model),
    }), /already consumed/);
    assert.equal(client.startCalls.length + client.resumeCalls.length, 0);
    assert.equal(pool.codexAppHostPoolStats().lanes, 0);
    client.die();
});

test('generation death synchronously rejects waiters and makes an unused token stale', async () => {
    const model = 'generation-death';
    const first = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const staleToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const lease = await pool.acquireCodexAppLane(first, {
        scopeKey: 'scope-death', bucketKey: bucket('scope-death', model),
    });
    const waitingToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const waiting = pool.acquireCodexAppLane(waitingToken, {
        scopeKey: 'scope-death', bucketKey: bucket('scope-death', model),
    });
    const waitingAssertion = assert.rejects(waiting, pool.CodexHostGenerationStaleError);
    const client = lease.client as unknown as FakeCodexAppClient;
    client.die();
    assert.throws(() => pool.acquireCodexAppLane(staleToken, {
        scopeKey: 'other', bucketKey: bucket('other', model),
    }), pool.CodexHostGenerationStaleError);
    assert.deepEqual(pool.codexAppHostPoolStats(), {
        hosts: 0, creatingHosts: 0, lanes: 0, busyLanes: 0, closing: false,
    });
    await waitingAssertion;
});

test('same-lane busy waiters acquire in FIFO order one head at a time', async () => {
    const model = 'fifo';
    const { lease: first, client } = await prepareFor(model, 'scope-fifo');
    const secondToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const thirdToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const order: string[] = [];
    const secondPromise = pool.acquireCodexAppLane(secondToken, {
        scopeKey: 'scope-fifo', bucketKey: bucket('scope-fifo', model),
    }).then((lease) => { order.push('second'); return lease; });
    const thirdPromise = pool.acquireCodexAppLane(thirdToken, {
        scopeKey: 'scope-fifo', bucketKey: bucket('scope-fifo', model),
    }).then((lease) => { order.push('third'); return lease; });
    await flush();
    assert.deepEqual(order, []);
    first!.release();
    const second = await secondPromise;
    assert.deepEqual(order, ['second']);
    second.release();
    const third = await thirdPromise;
    assert.deepEqual(order, ['second', 'third']);
    third.release(); client!.die();
});

test('resume uses laneScope and a recoverable missing thread falls back within only that lane', async () => {
    const model = 'resume-fallback';
    const first = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const second = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const resumed = await pool.acquireCodexAppLane(first, {
        scopeKey: 'scope-resume', bucketKey: bucket('scope-resume', model), storedThreadId: 'stored-thread',
    });
    const client = resumed.client as unknown as FakeCodexAppClient;
    assert.equal(resumed.resumedThread, true);
    assert.deepEqual(client.resumeCalls[0], {
        scope: 'scope-resume:resume-fallback:high', threadId: 'stored-thread',
        options: client.resumeCalls[0]?.options,
    });
    resumed.release();
    const recovered = await pool.acquireCodexAppLane(second, {
        scopeKey: 'scope-missing', bucketKey: bucket('scope-missing', model), storedThreadId: 'missing-thread',
    });
    assert.equal(recovered.resumedThread, false);
    assert.equal(client.resumeCalls[1]?.scope, 'scope-missing:resume-fallback:high');
    assert.equal(client.startCalls.at(-1)?.scope, 'scope-missing:resume-fallback:high');
    recovered.release(); client.die();
});

test('a timed-out waiter removes only itself and does not block the next FIFO row', async () => {
    const model = 'wait-timeout';
    const { lease, client } = await prepareFor(model, 'scope-timeout');
    const expiredToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const survivorToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const expired = pool.acquireCodexAppLane(expiredToken, {
        scopeKey: 'scope-timeout', bucketKey: bucket('scope-timeout', model), waitMs: 100,
    });
    const expiredAssertion = assert.rejects(expired, /timed out/);
    const survivor = pool.acquireCodexAppLane(survivorToken, {
        scopeKey: 'scope-timeout', bucketKey: bucket('scope-timeout', model), waitMs: 200,
    });
    await tick(100);
    await expiredAssertion;
    lease!.release();
    const survivorLease = await survivor;
    survivorLease.release(); client!.die();
});

test('lane reaper closes an idle sibling while another lane remains busy', async () => {
    const model = 'sibling-reap';
    const first = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const second = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const a = await pool.acquireCodexAppLane(first, {
        scopeKey: 'scope-a', bucketKey: bucket('scope-a', model),
    });
    const b = await pool.acquireCodexAppLane(second, {
        scopeKey: 'scope-b', bucketKey: bucket('scope-b', model),
    });
    const client = a.client as unknown as FakeCodexAppClient;
    a.release();
    await tick(15 * 60_000);
    assert.deepEqual(client.closeScopeCalls, ['scope-a:sibling-reap:high']);
    assert.equal(pool.codexAppHostPoolStats().lanes, 1);
    assert.equal(pool.codexAppHostPoolStats().busyLanes, 1);
    assert.equal(client.closeGracefullyCount, 0);
    b.release(); client.die();
});

test('close success transfers two queued waiters to an unbound row and wakes only the head', async () => {
    const model = 'close-success';
    const { lease, client } = await prepareFor(model, 'scope-close');
    lease!.release();
    const gate = deferred();
    client!.closeScopeGate = gate;
    await tick(15 * 60_000);
    const secondToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const thirdToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    let secondSettled = false, thirdSettled = false;
    const secondPromise = pool.acquireCodexAppLane(secondToken, {
        scopeKey: 'scope-close', bucketKey: bucket('scope-close', model),
    }).then((value) => { secondSettled = true; return value; });
    const thirdPromise = pool.acquireCodexAppLane(thirdToken, {
        scopeKey: 'scope-close', bucketKey: bucket('scope-close', model),
    }).then((value) => { thirdSettled = true; return value; });
    await flush();
    assert.equal(secondSettled || thirdSettled, false);
    gate.resolve(); client!.closeScopeGate = null;
    await flush();
    assert.equal(secondSettled, true);
    assert.equal(thirdSettled, false);
    const second = await secondPromise;
    assert.equal(client!.startCalls.length, 2);
    second.release();
    const third = await thirdPromise;
    assert.equal(thirdSettled, true);
    assert.equal(third.reused, true);
    third.release(); client!.die();
});

test('inactive close failure restores the same row and wakes one FIFO head', async () => {
    const model = 'close-inactive-fail';
    const { lease, client } = await prepareFor(model, 'scope-inactive');
    lease!.release();
    const gate = deferred();
    client!.closeScopeGate = gate;
    client!.closeScopeError = new Error('unsubscribe transport failed');
    await tick(15 * 60_000);
    const secondToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const thirdToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    let thirdSettled = false;
    const secondPromise = pool.acquireCodexAppLane(secondToken, {
        scopeKey: 'scope-inactive', bucketKey: bucket('scope-inactive', model),
    });
    const thirdPromise = pool.acquireCodexAppLane(thirdToken, {
        scopeKey: 'scope-inactive', bucketKey: bucket('scope-inactive', model),
    }).then((value) => { thirdSettled = true; return value; });
    gate.resolve(); client!.closeScopeGate = null;
    await flush();
    const second = await secondPromise;
    assert.equal(second.reused, true);
    assert.equal(thirdSettled, false);
    second.release();
    const third = await thirdPromise;
    third.release(); client!.closeScopeError = null; client!.die();
});

test('active close failure stays non-acquirable until completion schedules a later successful retry', async () => {
    const model = 'close-active-fail';
    const { lease, client } = await prepareFor(model, 'scope-active');
    const laneScope = lease!.laneScope;
    client!.setActive(laneScope);
    lease!.release();
    await tick(15 * 60_000);
    assert.equal(client!.closeScopeCalls.length, 1);
    const startsBefore = client!.startCalls.length;
    const secondToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const thirdToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    let secondSettled = false, thirdSettled = false;
    const secondPromise = pool.acquireCodexAppLane(secondToken, {
        scopeKey: 'scope-active', bucketKey: bucket('scope-active', model),
    }).then((value) => { secondSettled = true; return value; });
    const thirdPromise = pool.acquireCodexAppLane(thirdToken, {
        scopeKey: 'scope-active', bucketKey: bucket('scope-active', model),
    }).then((value) => { thirdSettled = true; return value; });
    await flush();
    assert.equal(secondSettled || thirdSettled, false);
    assert.equal(client!.startCalls.length, startsBefore);

    client!.complete(laneScope);
    assert.equal(client!.closeScopeCalls.length, 1, 'listener callback must not retry close inline');
    await flush();
    assert.equal(client!.closeScopeCalls.length, 2);
    assert.equal(secondSettled, true);
    assert.equal(thirdSettled, false);
    const second = await secondPromise;
    second.release();
    const third = await thirdPromise;
    third.release(); client!.die();
});

test('death after active close failure rejects every waiter without an RPC retry', async () => {
    const model = 'active-close-death';
    const { lease, client } = await prepareFor(model, 'scope-active-death');
    client!.setActive(lease!.laneScope);
    lease!.release();
    await tick(15 * 60_000);
    const secondToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const thirdToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const second = pool.acquireCodexAppLane(secondToken, {
        scopeKey: 'scope-active-death', bucketKey: bucket('scope-active-death', model),
    });
    const third = pool.acquireCodexAppLane(thirdToken, {
        scopeKey: 'scope-active-death', bucketKey: bucket('scope-active-death', model),
    });
    const closeCount = client!.closeScopeCalls.length;
    client!.die();
    await assert.rejects(second, pool.CodexHostGenerationStaleError);
    await assert.rejects(third, pool.CodexHostGenerationStaleError);
    assert.equal(client!.closeScopeCalls.length, closeCount);
});

test('cancel uses only laneScope and interrupt failure poisons the lane and rejects its waiter', async () => {
    const model = 'cancel-poison';
    const { lease, client } = await prepareFor(model, 'scope-cancel');
    const waitingToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const waiting = pool.acquireCodexAppLane(waitingToken, {
        scopeKey: 'scope-cancel', bucketKey: bucket('scope-cancel', model),
    });
    client!.interruptError = new Error('interrupt transport failed');
    await assert.rejects(lease!.cancel(), /interrupt transport failed/);
    await assert.rejects(waiting, /interrupt transport failed/);
    assert.deepEqual(client!.interruptCalls, ['scope-cancel:cancel-poison:high']);
    client!.die();
});

test('a waiter that times out after being transferred does not stall the rest of the queue', async () => {
    const model = 'transfer-timeout';
    const { lease, client } = await prepareFor(model, 'scope-transfer');
    lease!.release();
    const gate = deferred();
    client!.closeScopeGate = gate;
    await tick(15 * 60_000);
    const headToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const expiredToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const tailToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const head = pool.acquireCodexAppLane(headToken, {
        scopeKey: 'scope-transfer', bucketKey: bucket('scope-transfer', model), waitMs: 5_000,
    });
    const expired = pool.acquireCodexAppLane(expiredToken, {
        scopeKey: 'scope-transfer', bucketKey: bucket('scope-transfer', model), waitMs: 100,
    });
    const expiredAssertion = assert.rejects(expired, /timed out/);
    let tailSettled = false;
    const tail = pool.acquireCodexAppLane(tailToken, {
        scopeKey: 'scope-transfer', bucketKey: bucket('scope-transfer', model), waitMs: 5_000,
    }).then((value) => { tailSettled = true; return value; });
    await flush();
    gate.resolve(); client!.closeScopeGate = null;
    await flush();
    const headLease = await head;
    await tick(100);
    await expiredAssertion;
    assert.equal(tailSettled, false);
    headLease.release();
    await flush();
    assert.equal(tailSettled, true, 'the transferred timeout must not strand the queue behind a dead handoff');
    const tailLease = await tail;
    tailLease.release(); client!.die();
});

test('a queued normal waiter inherits a forceNew replacement instead of reviving the stored thread', async () => {
    const model = 'force-new-epoch';
    const seedToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const seeded = await pool.acquireCodexAppLane(seedToken, {
        scopeKey: 'scope-force', bucketKey: bucket('scope-force', model), storedThreadId: 'stored-force',
    });
    const client = seeded.client as unknown as FakeCodexAppClient;
    assert.equal(seeded.threadId, 'stored-force');
    const forceToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const normalToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const forcePromise = pool.acquireCodexAppLane(forceToken, {
        scopeKey: 'scope-force', bucketKey: bucket('scope-force', model), forceNew: true,
    });
    const normalPromise = pool.acquireCodexAppLane(normalToken, {
        scopeKey: 'scope-force', bucketKey: bucket('scope-force', model), storedThreadId: 'stored-force',
    });
    await flush();
    seeded.release();
    const forced = await forcePromise;
    assert.notEqual(forced.threadId, 'stored-force');
    const resumesBefore = client.resumeCalls.length;
    forced.release();
    const normal = await normalPromise;
    assert.equal(normal.threadId, forced.threadId);
    assert.equal(normal.reused, true);
    assert.equal(client.resumeCalls.length, resumesBefore, 'a superseded stored thread must not be resumed');
    normal.release(); client.die();
});

test('the pool listens as lifecycle so the run adapter still owns the handoff', async () => {
    // The pool attaches its own listener to every lane before the run's adapter
    // gets there. If that listener claimed to be the consumer the handoff buffer
    // would never turn on and the adapter would miss everything sent before it
    // attached, so the role has to say what this listener is for.
    const model = 'listener-role';
    const { lease, client } = await prepareFor(model, 'scope-role');
    assert.deepEqual(client!.listenRoles, [
        { scope: 'scope-role:listener-role:high', role: 'lifecycle' },
    ]);
    lease!.release(); client!.die();
});

test('host reaper waits until the last lane is gone and then closes the process', async () => {
    const model = 'host-reap';
    const { lease, client } = await prepareFor(model, 'scope-host-reap');
    lease!.release();
    await tick(15 * 60_000);
    assert.equal(client!.closeScopeCalls.length, 1);
    assert.equal(client!.closeGracefullyCount, 0);
    await tick(15 * 60_000);
    assert.equal(client!.closeGracefullyCount, 1);
    assert.equal(pool.codexAppHostPoolStats().hosts, 0);
});

// A compact deletes the scope's session_buckets rows, so the next spawn passes no
// stored thread and forceNew stays false. bindLane() then finds the idle lane still
// holding its threadId, decides nothing needs rebinding, and hands back the very
// conversation the compact discarded — with the fresh bootstrap injected into it.
// Dropping the binding is what makes the reset real (072 §1.2b).
test('invalidating a scope drops its idle lane binding so the next acquire starts a new thread', async () => {
    const model = `lane-invalidate-${identity++}`;
    const first = await prepareFor(model, 'scope-invalidate');
    const originalThread = first.lease!.threadId;
    first.lease!.release();

    // Without invalidation the idle lane is reused as-is.
    const preparedAgain = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const reusedLease = await pool.acquireCodexAppLane(preparedAgain, {
        scopeKey: 'scope-invalidate', bucketKey: bucket('scope-invalidate', model),
    });
    assert.equal(reusedLease.reused, true, 'an idle lane is reused when nothing invalidates it');
    assert.equal(reusedLease.threadId, originalThread);
    reusedLease.release();

    assert.equal(pool.invalidateCodexAppLanesForScope('scope-invalidate'), 1);

    const preparedAfter = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const freshLease = await pool.acquireCodexAppLane(preparedAfter, {
        scopeKey: 'scope-invalidate', bucketKey: bucket('scope-invalidate', model),
    });
    assert.equal(freshLease.reused, false, 'the lane must rebind after invalidation');
    assert.notEqual(freshLease.threadId, originalThread, 'and it must be a different thread');
    freshLease.release();
});

test('invalidating one scope leaves another scope alone and defers a busy lane', async () => {
    const model = `lane-invalidate-scoped-${identity++}`;
    const mine = await prepareFor(model, 'scope-mine');
    mine.lease!.release();
    const other = await prepareFor(model, 'scope-other');
    const otherThread = other.lease!.threadId;
    other.lease!.release();

    assert.equal(pool.invalidateCodexAppLanesForScope('scope-mine'), 1);

    const preparedOther = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const otherAgain = await pool.acquireCodexAppLane(preparedOther, {
        scopeKey: 'scope-other', bucketKey: bucket('scope-other', model),
    });
    assert.equal(otherAgain.reused, true, 'another scope keeps its binding');
    assert.equal(otherAgain.threadId, otherThread);
    otherAgain.release();
});

// The busy case is the dangerous one. The check that guards the explicit compact reads
// the default scope rather than the caller's, so a local session can compact while its
// own lane is running, and release preserves the thread id. Skipping such a lane would
// hand the discarded conversation straight back on the next turn.
test('a lane that is running when the reset lands loses its binding on release', async () => {
    const model = `lane-invalidate-busy-${identity++}`;
    const busy = await prepareFor(model, 'scope-busy');
    const runningThread = busy.lease!.threadId;

    assert.equal(pool.invalidateCodexAppLanesForScope('scope-busy'), 1, 'a busy lane is marked, not ignored');
    // The turn in flight keeps using its own thread; nothing is pulled out from under it.
    assert.equal(busy.lease!.threadId, runningThread);
    busy.lease!.release();

    const prepared = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const next = await pool.acquireCodexAppLane(prepared, {
        scopeKey: 'scope-busy', bucketKey: bucket('scope-busy', model),
    });
    assert.equal(next.reused, false, 'the deferred drop must force a rebind');
    assert.notEqual(next.threadId, runningThread, 'and the discarded thread must not come back');
    next.release();
});

// One reset marks the lane; the turn that follows must not keep paying for it.
test('a deferred drop is consumed once and does not disturb the following turn', async () => {
    const model = `lane-invalidate-once-${identity++}`;
    const busy = await prepareFor(model, 'scope-once');
    pool.invalidateCodexAppLanesForScope('scope-once');
    busy.lease!.release();

    const firstPrepared = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const first = await pool.acquireCodexAppLane(firstPrepared, {
        scopeKey: 'scope-once', bucketKey: bucket('scope-once', model),
    });
    const rebound = first.threadId;
    first.release();

    const secondPrepared = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const second = await pool.acquireCodexAppLane(secondPrepared, {
        scopeKey: 'scope-once', bucketKey: bucket('scope-once', model),
    });
    assert.equal(second.reused, true, 'the next turn reuses the lane normally');
    assert.equal(second.threadId, rebound);
    second.release();
});

// An instance-wide reset has no single scope to name.
test('a null scope invalidates every idle lane', async () => {
    const model = `lane-invalidate-all-${identity++}`;
    const a = await prepareFor(model, 'scope-all-a');
    a.lease!.release();
    const b = await prepareFor(model, 'scope-all-b');
    b.lease!.release();

    assert.ok(pool.invalidateCodexAppLanesForScope(null) >= 2);

    const prepared = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const lease = await pool.acquireCodexAppLane(prepared, {
        scopeKey: 'scope-all-a', bucketKey: bucket('scope-all-a', model),
    });
    assert.equal(lease.reused, false);
    lease.release();
});

// A waiter that queued before the invalidation must not continue the discarded thread.
// Clearing threadId is what carries this case: the waiter finds an unbound lane, so it
// rebinds regardless of what it inherits. The epoch bump alongside it keeps the lane
// consistent with every other rebinding path rather than being load-bearing here.
test('a waiter queued before an invalidation does not inherit the discarded binding', async () => {
    const model = `lane-invalidate-epoch-${identity++}`;
    const seedToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const seeded = await pool.acquireCodexAppLane(seedToken, {
        scopeKey: 'scope-epoch', bucketKey: bucket('scope-epoch', model), storedThreadId: 'stored-epoch',
    });
    assert.equal(seeded.threadId, 'stored-epoch');

    const waiterToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const waiterPromise = pool.acquireCodexAppLane(waiterToken, {
        scopeKey: 'scope-epoch', bucketKey: bucket('scope-epoch', model),
    });
    await flush();

    // The compact lands while the first turn still holds the lane, then the turn ends.
    seeded.release();
    assert.equal(pool.invalidateCodexAppLanesForScope('scope-epoch'), 1);

    const waiter = await waiterPromise;
    assert.notEqual(waiter.threadId, 'stored-epoch', 'the waiter must not continue the discarded thread');
    waiter.release();
});

test('shutdown is deadline-bound, rejects waiters, and memoizes the first deadline and reserve', async () => {
    const model = 'shutdown';
    const reaped = await prepareFor('shutdown-reaped', 'scope-reaped');
    const reapedClient = reaped.client!;
    reaped.lease!.release();
    const { lease, client } = await prepareFor(model, 'scope-shutdown');
    client!.setActive(lease!.laneScope);
    lease!.release();
    await tick(15 * 60_000);
    assert.equal(client!.closeScopeCalls.length, 1);
    assert.equal(reapedClient.closeScopeCalls.length, 1);
    reapedClient.closeGracefullyGate = deferred();
    await tick(15 * 60_000);
    assert.equal(reapedClient.closeGracefullyCount, 1, 'the reaper must have started its graceful close');
    const waitingToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const unusedToken = await pool.prepareCodexAppHost(prepareOptions({ model }));
    const waiting = pool.acquireCodexAppLane(waitingToken, {
        scopeKey: 'scope-shutdown', bucketKey: bucket('scope-shutdown', model),
    });
    const initializeGate = deferred();
    fakeState.nextInitialize = initializeGate.promise;
    const creating = pool.prepareCodexAppHost(prepareOptions({ model: 'shutdown-creating' }));
    await flush();
    fakeState.nextInitialize = null;
    client!.closeGracefullyGate = deferred();
    const startedAt = Date.now();
    const first = pool.shutdownCodexAppHostPool({
        reason: 'unit shutdown', deadlineAt: startedAt + 1_000, reserveMs: 200,
    });
    const second = pool.shutdownCodexAppHostPool({ deadlineAt: startedAt + 100_000 });
    assert.equal(first, second);
    assert.throws(() => pool.acquireCodexAppLane(unusedToken, {
        scopeKey: 'scope-after-closing', bucketKey: bucket('scope-after-closing', model),
    }), pool.CodexHostPoolClosingError);
    await assert.rejects(waiting, pool.CodexHostPoolClosingError);
    await assert.rejects(creating, pool.CodexHostPoolClosingError);
    await tick(799);
    assert.equal(client!.killCount, 0);
    assert.equal(reapedClient.killCount, 0);
    await tick(1);
    assert.equal(client!.killCount, 1, 'reserve must leave 200ms for the caller tail');
    assert.equal(reapedClient.killCount, 1, 'shutdown must own a host the reaper is still closing');
    await tick(200);
    await first;
    assert.equal(client!.closeScopeCalls.length, 1, 'shutdown must not retry a scoped close RPC');
    assert.equal(reapedClient.closeGracefullyCount, 1, 'shutdown must not re-issue a pending graceful close');
    initializeGate.resolve();
    await flush();
    assert.deepEqual(pool.codexAppHostPoolStats(), {
        hosts: 0, creatingHosts: 0, lanes: 0, busyLanes: 0, closing: true,
    });
    await assert.rejects(
        pool.prepareCodexAppHost(prepareOptions({ model: 'after-shutdown' })),
        pool.CodexHostPoolClosingError,
    );
});
