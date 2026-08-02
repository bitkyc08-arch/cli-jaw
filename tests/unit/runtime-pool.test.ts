import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

type Deferred = { promise: Promise<void>; resolve(): void };

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

type InterruptMode = 'success' | 'reject' | 'completed' | 'failed' | 'timeout';
const fakeState: {
    instances: FakeCodexAppClient[];
    nextInitialize: Promise<void> | null;
    interruptMode: InterruptMode;
    nextThread: number;
} = { instances: [], nextInitialize: null, interruptMode: 'success', nextThread: 1 };

class FakeCodexAppClient extends EventEmitter {
    proc = { exitCode: null as number | null, killed: false, pid: 40_000 + fakeState.instances.length };
    threadId: string | null = null;
    activeTurnId: string | null = null;
    closeCount = 0;
    killCount = 0;
    interruptCount = 0;
    initializeCount = 0;

    constructor(_options: unknown = {}) {
        super();
        fakeState.instances.push(this);
    }

    get alive(): boolean {
        return this.proc.exitCode === null && !this.proc.killed;
    }

    spawn(): void {}

    async initialize(): Promise<void> {
        this.initializeCount += 1;
        if (fakeState.nextInitialize) await fakeState.nextInitialize;
    }

    async startThread(): Promise<string> {
        this.threadId = `thread-${fakeState.nextThread++}`;
        return this.threadId;
    }

    async resumeThread(threadId: string): Promise<string> {
        if (threadId.startsWith('missing-')) throw new Error(`no rollout found for thread id ${threadId}`);
        this.threadId = threadId;
        return threadId;
    }

    async interruptTurn(): Promise<void> {
        this.interruptCount += 1;
        if (fakeState.interruptMode === 'reject') throw new Error('interrupt transport failed');
        if (fakeState.interruptMode === 'completed') this.emit('turn/completed', {});
        if (fakeState.interruptMode === 'failed') this.emit('interrupt-failed', new Error('latch send failed'));
    }

    async closeGracefully(): Promise<void> {
        this.closeCount += 1;
        this.proc.killed = true;
    }

    kill(): void {
        this.killCount += 1;
        this.proc.killed = true;
    }

    die(): void {
        this.proc.exitCode = 1;
        this.emit('exit', 1, null);
    }
}

mock.module('../../src/agent/codex-app-client.js', {
    namedExports: {
        CodexAppClient: FakeCodexAppClient,
        isRecoverableResumeError: (message: string) => /not found|no rollout found|unknown thread/i.test(message),
    },
});

const {
    acquireCodexAppRuntime,
    poolStats,
} = await import('../../src/agent/runtime-pool.js');

let scopeSequence = 1;
function options(overrides: {
    scopeKey?: string;
    model?: string;
    forceNew?: boolean;
    storedThreadId?: string | null;
    waitMs?: number;
} = {}) {
    return {
        binary: 'fake-codex',
        env: {},
        key: {
            scopeKey: overrides.scopeKey ?? `scope-${scopeSequence++}`,
            cwd: '/tmp/runtime-pool-test',
            model: overrides.model ?? 'gpt-test',
            effort: 'medium',
            fastMode: false,
        },
        ...(overrides.forceNew === undefined ? {} : { forceNew: overrides.forceNew }),
        ...(overrides.storedThreadId === undefined ? {} : { storedThreadId: overrides.storedThreadId }),
        ...(overrides.waitMs === undefined ? {} : { waitMs: overrides.waitMs }),
    };
}

function fakeClient(lease: { client: unknown }): FakeCodexAppClient {
    return lease.client as FakeCodexAppClient;
}

function retire(lease: { release(): void; client: unknown }): void {
    lease.release();
    fakeClient(lease).die();
}

test('full pool keys keep different scopes in independent entries', async () => {
    const before = poolStats().size;
    const first = await acquireCodexAppRuntime(options({ scopeKey: `key-a-${scopeSequence++}` }));
    const second = await acquireCodexAppRuntime(options({ scopeKey: `key-b-${scopeSequence++}` }));
    assert.notEqual(first.client, second.client);
    assert.equal(poolStats().size, before + 2);
    retire(first);
    retire(second);
});

test('scope index replacement closes stale settings for the same scope', async () => {
    const scopeKey = `replace-${scopeSequence++}`;
    const first = await acquireCodexAppRuntime(options({ scopeKey, model: 'model-a' }));
    const firstClient = fakeClient(first);
    first.release();
    const second = await acquireCodexAppRuntime(options({ scopeKey, model: 'model-b' }));
    assert.equal(firstClient.closeCount, 1);
    assert.notEqual(second.client, first.client);
    retire(second);
});

test('forceNew bypass closes and replaces an otherwise reusable entry', async () => {
    const scopeKey = `force-${scopeSequence++}`;
    const first = await acquireCodexAppRuntime(options({ scopeKey }));
    const firstClient = fakeClient(first);
    const firstThreadId = first.threadId;
    first.release();
    const second = await acquireCodexAppRuntime(options({
        scopeKey, forceNew: true, storedThreadId: firstThreadId,
    }));
    assert.equal(firstClient.closeCount, 1);
    assert.equal(second.reused, false);
    assert.equal(second.resumedThread, false);
    assert.notEqual(second.threadId, firstThreadId);
    assert.notEqual(second.client, first.client);
    retire(second);
});

test('creating-state concurrent acquire performs one initialization and returns independent leases', async () => {
    const gate = deferred();
    fakeState.nextInitialize = gate.promise;
    const scopeKey = `creating-${scopeSequence++}`;
    const before = fakeState.instances.length;
    const firstPromise = acquireCodexAppRuntime(options({ scopeKey }));
    const secondPromise = acquireCodexAppRuntime(options({ scopeKey }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fakeState.instances.length, before + 1);
    gate.resolve();
    fakeState.nextInitialize = null;
    const first = await firstPromise;
    let secondSettled = false;
    void secondPromise.then(() => { secondSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false);
    first.release();
    const second = await secondPromise;
    assert.equal(second.client, first.client);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    retire(second);
});

test('busy wait timeout removes only the expired waiter', async () => {
    const scopeKey = `timeout-${scopeSequence++}`;
    const first = await acquireCodexAppRuntime(options({ scopeKey }));
    await assert.rejects(
        acquireCodexAppRuntime(options({ scopeKey, waitMs: 5 })),
        /acquire timed out/,
    );
    first.release();
    const next = await acquireCodexAppRuntime(options({ scopeKey, waitMs: 50 }));
    assert.equal(next.client, first.client);
    retire(next);
});

test('dead runtime is recreated by resuming its stored thread', async () => {
    const scopeKey = `dead-${scopeSequence++}`;
    const first = await acquireCodexAppRuntime(options({ scopeKey }));
    const threadId = first.threadId;
    const oldClient = fakeClient(first);
    first.release();
    oldClient.proc.exitCode = 1;
    const next = await acquireCodexAppRuntime(options({ scopeKey, storedThreadId: threadId }));
    assert.notEqual(next.client, oldClient);
    assert.equal(next.threadId, threadId);
    assert.equal(next.resumedThread, true);
    retire(next);
});

test('recoverable resume failure starts a new thread without poisoning the entry', async () => {
    const lease = await acquireCodexAppRuntime(options({ storedThreadId: 'missing-thread' }));
    assert.notEqual(lease.threadId, 'missing-thread');
    assert.equal(lease.resumedThread, false);
    retire(lease);
});

test('release drains a busy waiter and transfers the runtime lease', async () => {
    const scopeKey = `release-${scopeSequence++}`;
    const first = await acquireCodexAppRuntime(options({ scopeKey }));
    const waiting = acquireCodexAppRuntime(options({ scopeKey, waitMs: 100 }));
    first.release();
    const second = await waiting;
    assert.equal(second.client, first.client);
    retire(second);
});

test('dead exit rejects busy waiters before release cleanup', async () => {
    const scopeKey = `exit-${scopeSequence++}`;
    const first = await acquireCodexAppRuntime(options({ scopeKey }));
    const waiting = acquireCodexAppRuntime(options({ scopeKey, waitMs: 100 }));
    fakeClient(first).die();
    await assert.rejects(waiting, /runtime exited/);
    first.release();
});

test('interrupt-capable cancel preserves a live process', async () => {
    fakeState.interruptMode = 'success';
    const lease = await acquireCodexAppRuntime(options());
    const client = fakeClient(lease);
    client.activeTurnId = 'turn-active';
    await lease.cancel();
    assert.equal(client.interruptCount, 1);
    assert.equal(client.killCount, 0);
    retire(lease);
});

test('failed interrupt cancel kills, marks dead, and rejects waiters', async () => {
    fakeState.interruptMode = 'reject';
    const scopeKey = `cancel-${scopeSequence++}`;
    const lease = await acquireCodexAppRuntime(options({ scopeKey }));
    const client = fakeClient(lease);
    client.activeTurnId = 'turn-active';
    const waiting = acquireCodexAppRuntime(options({ scopeKey, waitMs: 100 }));
    await lease.cancel();
    assert.equal(client.killCount, 1);
    await assert.rejects(waiting, /cancelled and discarded/);
    lease.release();
    fakeState.interruptMode = 'success';
});

for (const mode of ['completed', 'failed'] as const) {
    test(`latch interrupt ${mode} path removes all event listeners`, async () => {
        fakeState.interruptMode = mode;
        const lease = await acquireCodexAppRuntime(options());
        const client = fakeClient(lease);
        client.activeTurnId = null;
        await lease.cancel();
        assert.equal(client.listenerCount('interrupt-failed'), 0);
        assert.equal(client.listenerCount('turn/completed'), 0);
        if (mode === 'failed') assert.equal(client.killCount, 1);
        lease.release();
        if (client.alive) client.die();
    });
}

test('latch terminal race is treated as completed and leaves no listeners', async () => {
    fakeState.interruptMode = 'completed';
    const lease = await acquireCodexAppRuntime(options());
    const client = fakeClient(lease);
    await lease.cancel();
    assert.equal(client.killCount, 0);
    assert.equal(client.listenerCount('interrupt-failed'), 0);
    assert.equal(client.listenerCount('turn/completed'), 0);
    retire(lease);
});

test('latch timeout removes listeners and falls back to kill', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    fakeState.interruptMode = 'timeout';
    const lease = await acquireCodexAppRuntime(options());
    const client = fakeClient(lease);
    const cancelling = lease.cancel();
    t.mock.timers.tick(10_000);
    await cancelling;
    assert.equal(client.listenerCount('interrupt-failed'), 0);
    assert.equal(client.listenerCount('turn/completed'), 0);
    assert.equal(client.killCount, 1);
    lease.release();
    t.mock.timers.reset();
    fakeState.interruptMode = 'success';
});

test('spawn contract keeps employees per-turn and routes boss cancellation through the lease', () => {
    const source = readFileSync(new URL('../../src/agent/spawn.ts', import.meta.url), 'utf8');
    const employeeBranch = source.indexOf('if (opts.agentId) {', source.indexOf("if (cli === 'codex-app')"));
    const directClient = source.indexOf('new CodexAppClient({', employeeBranch);
    const acquire = source.indexOf('acquireCodexAppRuntime({', employeeBranch);
    assert.ok(employeeBranch > 0 && directClient > employeeBranch && acquire > directClient);
    assert.match(source, /action=lease\.cancel/);
    assert.match(source, /CODEX_APP_TURN_IDLE_MS/);
    assert.match(source, /CODEX_APP_TURN_ABS_MS/);
    assert.match(source, /watchdog stall/);
});

test('pool storage is partitioned by engine before full-key and scope indexing', () => {
    const source = readFileSync(new URL('../../src/agent/runtime-pool.ts', import.meta.url), 'utf8');
    assert.match(source, /type Engine = 'codex-app' \| 'pi'/);
    assert.match(source, /const stores = new Map<Engine, EngineStore>\(\)/);
    assert.match(source, /storeFor\('codex-app'\)/);
});
