import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import type { AcpSession } from '../../src/agent/runtime/acp/session.ts';
import type { GrokSessionOptions } from '../../src/agent/runtime/acp/grok-session.ts';
import type { GrokAcquireOptions, CursorLease } from '../../src/agent/runtime-pool.ts';

// Replace only the process factory; acquisition, scope indexes and leases are real.
let defaultFactory: ((options: GrokSessionOptions) => Promise<AcpSession>) | undefined;
mock.module('../../src/agent/runtime/acp/grok-session.js', { namedExports: {
    createGrokSession: (options: GrokSessionOptions) => {
        assert.ok(defaultFactory, 'unexpected default Grok factory call');
        return defaultFactory(options);
    },
} });
const { acquireGrokRuntime, acquireCursorRuntime, poolStats } = await import('../../src/agent/runtime-pool.ts');

function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
let sequence = 0;
class PoolSession {
    child = new EventEmitter();
    alive = true; idle = true;
    nativeSessionId = `grok-pool-native-${++sequence}`;
    closeCalls = 0; retireCalls = 0; cancelCalls = 0; dispatched = 0;
    holdClose = false;
    closeGate = deferred(); closeStarted = deferred();
    retire(): void { this.retireCalls++; this.alive = false; this.idle = false; }
    close(): Promise<void> {
        this.closeCalls++; this.closeStarted.resolve();
        if (this.holdClose) return this.closeGate.promise;
        this.exit(); return Promise.resolve();
    }
    async cancel(): Promise<void> { this.cancelCalls++; }
    async prompt(): Promise<void> { assert.equal(this.alive, true); this.dispatched++; }
    exit(): void { this.alive = false; this.child.emit('exit', 0); }
}
function fixture(t: TestContext) {
    const sessions: PoolSession[] = [], creations: GrokSessionOptions[] = [];
    let generation = 0;
    const options: GrokAcquireOptions = {
        key: { scopeKey: `grok-pool-scope-${++sequence}`, cwd: process.cwd(), model: 'grok-4.6', effort: 'high', permissions: 'auto' },
        binary: 'fake-acp', env: { XAI_API_KEY: 'fixture-key-a', HOME: '/fixture/home-a',
            USERPROFILE: '/fixture/profile-a', GROK_HOME: '/fixture/grok-a', GROK_AUTH_PATH: '/fixture/auth-a' },
        promptTimeoutMs: 1000, waitMs: 1000, persistenceOwner: { global: 0, scope: 0 },
        isCurrentOwner: owner => owner.global === generation && owner.scope === 0, canAcquire: () => true,
        createSession: async input => {
            creations.push(input); const session = new PoolSession();
            if (input.resumeSessionId) session.nativeSessionId = input.resumeSessionId;
            sessions.push(session); return session as unknown as AcpSession;
        },
    };
    t.after(() => { for (const session of sessions) { session.exit(); session.closeGate.resolve(); } });
    return { options, sessions, creations, reset: () => ++generation };
}
async function dispatch(lease: CursorLease) {
    await (lease.session as unknown as PoolSession).prompt();
}

test('shared reaper retains Grok close fences and skips busy Grok and Cursor leases', { timeout: 5000 }, async t => {
    let sweep!: () => void, now = 0;
    const interval = globalThis.setInterval;
    t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
        sweep = callback; return interval(callback, delay);
    });
    t.mock.method(Date, 'now', () => now);
    const f = fixture(t), first = await acquireGrokRuntime(f.options), old = f.sessions[0]!;
    old.holdClose = true; first.release();
    const busy = await acquireGrokRuntime({ ...f.options, key: { ...f.options.key, scopeKey: 'busy-' + f.options.key.scopeKey } });
    const cursor = await acquireCursorRuntime(f.options);
    now = 15 * 60_000; sweep(); sweep();
    assert.equal(old.closeCalls, 1); assert.equal(poolStats().size, 3);
    assert.equal(busy.runtime.alive, true); assert.equal(cursor.runtime.alive, true);
    const next = acquireGrokRuntime(f.options);
    await checkpoint(); assert.equal(f.creations.length, 3);
    old.closeGate.resolve(); const replacement = await next;
    await dispatch(replacement); replacement.release(); busy.release(); cursor.release();
});

for (const acquire of [acquireGrokRuntime, acquireCursorRuntime]) {
    test(`${acquire.name} reuses a released session and fences stale lease methods`, async t => {
        const f = fixture(t), first = await acquire(f.options); first.release();
        const second = await acquire(f.options);
        assert.equal(second.session, first.session); assert.equal(second.reused, true);
        await first.retire(); await first.cancel(); first.release();
        assert.equal(f.sessions[0]!.retireCalls, 0); assert.equal(f.sessions[0]!.cancelCalls, 0);
        await dispatch(second); second.release(); assert.equal(f.creations.length, 1);
    });
}

test('identical scope and key fields keep Grok and Cursor independently busy', async t => {
    const f = fixture(t), grok = await acquireGrokRuntime(f.options), cursor = await acquireCursorRuntime(f.options);
    assert.notEqual(grok.session, cursor.session); assert.equal(poolStats().busy, 2);
    await grok.retire(); grok.release();
    await dispatch(cursor); assert.equal(f.sessions[1]!.closeCalls, 0); cursor.release();
    const cursorAgain = await acquireCursorRuntime({ ...f.options, env: { XAI_API_KEY: 'changed' } });
    assert.equal(cursorAgain.session, cursor.session); cursorAgain.release();
});

test('Cursor retains its exact key tuple and Grok keys contain only an auth digest', async t => {
    const f = fixture(t), keys: unknown[][] = [];
    const set = Map.prototype.set;
    t.mock.method(Map.prototype, 'set', function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (typeof key === 'string' && (key.startsWith('["cursor",') || key.startsWith('["grok",'))) {
            keys.push(JSON.parse(key) as unknown[]);
        }
        return set.call(this, key, value);
    });
    const cursor = await acquireCursorRuntime(f.options), grok = await acquireGrokRuntime(f.options);
    const cursorKey = ['cursor', f.options.key.scopeKey, realpathSync(f.options.key.cwd), f.options.binary,
        f.options.key.model, f.options.key.effort, 'auto', 'native'];
    assert.deepEqual(keys.find(key => key[0] === 'cursor'), cursorKey);
    const grokKey = keys.find(key => key[0] === 'grok')!;
    assert.deepEqual(grokKey.slice(0, -1), ['grok', ...cursorKey.slice(1)]);
    assert.match(String(grokKey.at(-1)), /^[a-f0-9]{64}$/);
    for (const value of Object.values(f.options.env)) assert.equal(JSON.stringify(grokKey).includes(value!), false);
    cursor.release(); grok.release();
});

for (const field of ['XAI_API_KEY', 'HOME', 'USERPROFILE', 'GROK_HOME', 'GROK_AUTH_PATH']) {
    test(`${field} change waits for full logical release then physical close`, { timeout: 5000 }, async t => {
        const f = fixture(t), first = await acquireGrokRuntime(f.options), old = f.sessions[0]!;
        old.holdClose = true;
        const next = acquireGrokRuntime({ ...f.options, env: { ...f.options.env, [field]: 'changed-fixture-value' } });
        await checkpoint(); assert.equal(old.idle, true); assert.equal(old.closeCalls, 0);
        old.exit(); await checkpoint();
        assert.equal(old.closeCalls, 0); assert.equal(f.creations.length, 1);
        first.release(); await old.closeStarted.promise; await checkpoint();
        assert.equal(f.creations.length, 1); old.closeGate.resolve();
        const second = await next; assert.notEqual(second.session, first.session);
        await dispatch(second); second.release();
    });
}

test('unrelated env changes reuse Grok and captured env reaches the factory unchanged', async t => {
    const f = fixture(t), first = await acquireGrokRuntime(f.options); first.release();
    const second = await acquireGrokRuntime({ ...f.options, env: { ...f.options.env, NO_COLOR: '1' } });
    assert.equal(second.session, first.session); assert.equal(f.creations.length, 1);
    assert.deepEqual(f.creations[0]!.env, f.options.env); second.release();
});

test('admission callbacks and pending callers cannot mutate captured identity or factory', async t => {
    const f = fixture(t);
    const captured = { ...f.options, key: { ...f.options.key }, env: { ...f.options.env }, persistenceOwner: { ...f.options.persistenceOwner } };
    const started = deferred(), gate = deferred<AcpSession>();
    const originalFactory = f.options.createSession!;
    f.options.createSession = async input => { const session = await originalFactory(input); started.resolve(); await gate.promise; return session; };
    f.options.isCurrentOwner = owner => {
        f.options.key.model = 'wrong-model'; f.options.key.cwd = '/fixture/invalid';
        f.options.key.scopeKey = 'wrong-scope'; f.options.key.permissions = 'safe';
        f.options.env['XAI_API_KEY'] = 'wrong-key'; f.options.env['HOME'] = '/wrong-home';
        f.options.persistenceOwner.global = 999; f.options.binary = 'wrong-binary';
        f.options.createSession = async () => { throw new Error('wrong factory'); };
        return owner.global === 0;
    };
    const pending = acquireGrokRuntime(f.options);
    await started.promise;
    f.options.env['GROK_AUTH_PATH'] = '/mutated-during-create';
    assert.equal(f.creations[0]!.model, captured.key.model);
    assert.equal(f.creations[0]!.binary, captured.binary);
    assert.equal(f.creations[0]!.cwd, realpathSync(captured.key.cwd));
    assert.equal(f.creations[0]!.permissions, 'auto'); assert.deepEqual(f.creations[0]!.env, captured.env);
    gate.resolve(f.sessions[0] as unknown as AcpSession); const first = await pending; first.release();
    const second = await acquireGrokRuntime(captured);
    assert.equal(second.session, first.session); assert.equal(f.creations.length, 1); second.release();
});

test('non-auto permissions fail before admission, cwd lookup, factory or force-new pool work', async t => {
    const f = fixture(t), first = await acquireGrokRuntime(f.options); first.release();
    let admissions = 0;
    for (const permissions of ['safe', [], ['auto'], ['read'], undefined, null, 'AUTO', true]) {
        await assert.rejects(acquireGrokRuntime({ ...f.options, forceNew: true,
            key: { ...f.options.key, cwd: '/fixture/does-not-exist', permissions },
            canAcquire: () => { admissions++; return true; },
        }), /grok_acp_restrictive_policy_unverified|invalid_native_permissions/);
    }
    assert.equal(admissions, 0); assert.equal(f.creations.length, 1); assert.equal(f.sessions[0]!.alive, true);
    const next = await acquireGrokRuntime(f.options); assert.equal(next.session, first.session); next.release();
});

test('omitted factory selects Grok and preserves resume options', async t => {
    const f = fixture(t); defaultFactory = f.options.createSession;
    t.after(() => { defaultFactory = undefined; });
    const options = { ...f.options, storedSessionId: 'stored-grok' }; delete options.createSession;
    const first = await acquireGrokRuntime(options);
    assert.equal(first.sessionId, 'stored-grok'); assert.equal(f.creations[0]!.resumeSessionId, 'stored-grok');
    assert.equal(f.creations[0]!.effort, 'high'); first.release();
});

test('aborted late creation closes only its own session and cannot delete a new borrower', { timeout: 5000 }, async t => {
    const f = fixture(t), controller = new AbortController(), started = deferred(), gate = deferred<AcpSession>();
    const old = new PoolSession(); f.sessions.push(old); let signal: AbortSignal | undefined;
    const pending = acquireGrokRuntime({ ...f.options, signal: controller.signal, createSession: async input => {
        signal = input.signal; started.resolve(); return gate.promise;
    } });
    const rejected = assert.rejects(pending, /aborted/);
    await started.promise; controller.abort(); await rejected; assert.equal(signal?.aborted, true);
    const replacement = await acquireGrokRuntime(f.options);
    gate.resolve(old as unknown as AcpSession); await checkpoint();
    assert.equal(old.closeCalls, 1); assert.equal(old.retireCalls, 1);
    await dispatch(replacement); replacement.release();
    const reused = await acquireGrokRuntime(f.options); assert.equal(reused.session, replacement.session); reused.release();
});

test('rejected old close fences Grok until captured exit and never interrupts Cursor', { timeout: 5000 }, async t => {
    const f = fixture(t), first = await acquireGrokRuntime(f.options), old = f.sessions[0]!;
    const cursor = await acquireCursorRuntime(f.options); old.holdClose = true;
    const retiring = first.retire(); const rejected = assert.rejects(retiring, /fixture close failure/); first.release();
    old.closeGate.reject(new Error('fixture close failure')); await rejected;
    const next = acquireGrokRuntime(f.options); await checkpoint();
    assert.equal(poolStats().size, 2); assert.equal(f.creations.length, 2); assert.equal(old.closeCalls, 1);
    await dispatch(cursor); assert.equal(f.sessions[1]!.closeCalls, 0);
    old.exit(); const second = await next;
    await first.retire(); await first.cancel(); first.release();
    await dispatch(second); second.release(); cursor.release();
    const reused = await acquireGrokRuntime(f.options); assert.equal(reused.session, second.session); reused.release();
});

for (const outcome of ['resolve', 'reject'] as const) {
    test(`old close ${outcome} after exit cannot delete its same-key successor`, { timeout: 5000 }, async t => {
        const f = fixture(t), first = await acquireGrokRuntime(f.options), old = f.sessions[0]!;
        old.holdClose = true; const retiring = first.retire();
        const settled = outcome === 'reject' ? assert.rejects(retiring, /late close/) : retiring;
        const next = acquireGrokRuntime(f.options); old.exit(); const second = await next;
        if (outcome === 'reject') old.closeGate.reject(new Error('late close')); else old.closeGate.resolve();
        await settled; first.release(); await first.cancel(); await first.retire();
        assert.equal(f.sessions[1]!.closeCalls, 0); await dispatch(second); second.release();
        const third = await acquireGrokRuntime(f.options); assert.equal(third.session, second.session); third.release();
    });
}

test('owner generation replacement retains the physical retirement fence', { timeout: 5000 }, async t => {
    const f = fixture(t), first = await acquireGrokRuntime(f.options), old = f.sessions[0]!;
    old.holdClose = true;
    const next = acquireGrokRuntime({ ...f.options, persistenceOwner: { global: f.reset(), scope: 0 } });
    await old.closeStarted.promise; await checkpoint(); assert.equal(f.creations.length, 1);
    old.closeGate.resolve(); const second = await next;
    first.release(); await first.retire(); await first.cancel();
    assert.equal(f.sessions[1]!.closeCalls, 0); await dispatch(second); second.release();
});
