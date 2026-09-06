import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AcpSession } from '../../src/agent/runtime/acp/session.ts';
import { acquireCursorRuntime, poolStats, type CursorAcquireOptions, type CursorLease } from '../../src/agent/runtime-pool.ts';

function deferred() {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
let sequence = 0;
class FencedSession {
    child = new EventEmitter();
    alive = true; idle = true;
    nativeSessionId = `retirement-session-${++sequence}`;
    closeCalls = 0; retireCalls = 0; cancelCalls = 0; dispatched = 0;
    closeGate = deferred(); closeStarted = deferred();
    retire(): void { this.retireCalls++; this.alive = false; this.idle = false; }
    close(): Promise<void> { this.closeCalls++; this.closeStarted.resolve(); return this.closeGate.promise; }
    async cancel(): Promise<void> { this.cancelCalls++; }
    async prompt(): Promise<void> { assert.equal(this.alive, true); this.dispatched++; }
    exit(): void { this.alive = false; this.child.emit('exit', 0); }
}
function fixture(t: TestContext) {
    const sessions: FencedSession[] = [];
    let generation = 0;
    const options: CursorAcquireOptions = {
        key: { scopeKey: `retirement-scope-${++sequence}`, cwd: process.cwd(), model: 'a', effort: '', permissions: 'auto' },
        binary: 'fake-cursor', env: {}, promptTimeoutMs: 1000, waitMs: 1000,
        persistenceOwner: { global: 0, scope: 0 }, isCurrentOwner: owner => owner.global === generation,
        canAcquire: () => true,
        createSession: async () => { const session = new FencedSession(); sessions.push(session); return session as unknown as AcpSession; },
    };
    t.after(() => { for (const s of sessions) { s.exit(); s.closeGate.resolve(); } });
    return { options, sessions, reset: () => ++generation,
        changed: (model: string): CursorAcquireOptions => ({ ...options, key: { ...options.key, model } }) };
}
async function dispatch(lease: CursorLease): Promise<void> {
    // Only the pool boundary is under test: no provider/CLI, but actual observable prompt admission.
    await (lease.session as unknown as FencedSession).prompt();
}

test('idle reaper and repeated release retain one close fence until observed completion', { timeout: 5000 }, async t => {
    let sweep!: () => void;
    const interval = globalThis.setInterval;
    t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
        sweep = callback; return interval(callback, delay);
    });
    let now = 0; t.mock.method(Date, 'now', () => now);
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    a.release(); now = 15 * 60_000; sweep(); sweep(); a.release();
    assert.equal(old.closeCalls, 1); assert.equal(poolStats().size, 1);
    let admitted = false;
    const next = acquireCursorRuntime(f.options).then(async lease => { admitted = true; await dispatch(lease); return lease; });
    await checkpoint(); assert.equal(admitted, false); assert.equal(f.sessions.length, 1);
    old.closeGate.resolve(); const b = await next;
    assert.equal(f.sessions[1]!.dispatched, 1); b.release();
});

test('different-key replacement cannot become ready or dispatch before old close resolves', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    a.release();
    let admitted = false;
    const next = acquireCursorRuntime(f.changed('b')).then(async lease => { admitted = true; await dispatch(lease); return lease; });
    await old.closeStarted.promise; await checkpoint();
    assert.equal(admitted, false); assert.equal(f.sessions.length, 1); assert.equal(poolStats().size, 1);
    old.closeGate.resolve(); const b = await next;
    assert.equal(f.sessions[1]!.dispatched, 1); b.release();
});

test('rejected close keeps the fence despite alive=false; actual captured exit admits replacement', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    const retiring = a.retire(new Error('cleanup uncertain'));
    const rejected = assert.rejects(retiring, /reap failed/);
    assert.equal(old.alive, false); a.release();
    old.closeGate.reject(new Error('reap failed')); await rejected;
    let admitted = false;
    const next = acquireCursorRuntime(f.changed('b')).then(async lease => { admitted = true; await dispatch(lease); return lease; });
    await checkpoint(); assert.equal(admitted, false); assert.equal(poolStats().size, 1); assert.equal(old.closeCalls, 1);
    old.exit(); const b = await next;
    assert.equal(f.sessions[1]!.dispatched, 1); assert.equal(old.child.listenerCount('exit'), 0); b.release();
});

test('normal different-key change waits for full logical release even after protocol idle or child exit', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    const next = acquireCursorRuntime(f.changed('b'));
    await checkpoint(); assert.equal(old.closeCalls, 0); assert.equal(f.sessions.length, 1);
    old.exit(); await checkpoint();
    assert.equal(old.closeCalls, 0); assert.equal(f.sessions.length, 1);
    a.release(); await old.closeStarted.promise; old.closeGate.resolve();
    const b = await next; await dispatch(b); b.release();
});

test('parallel different-key waiters rescan the scope after close and cannot double-admit', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    a.release();
    const admitted: CursorLease[] = [];
    const bPending = acquireCursorRuntime(f.changed('b')).then(async lease => { admitted.push(lease); await dispatch(lease); return lease; });
    const cPending = acquireCursorRuntime(f.changed('c')).then(async lease => { admitted.push(lease); await dispatch(lease); return lease; });
    await old.closeStarted.promise; old.closeGate.resolve(); await checkpoint();
    assert.equal(admitted.length, 1); assert.equal(f.sessions.length, 2);
    assert.equal(f.sessions[1]!.closeCalls, 0); assert.equal(f.sessions[1]!.dispatched, 1);
    admitted[0]!.release(); await f.sessions[1]!.closeStarted.promise;
    assert.equal(f.sessions.length, 2);
    f.sessions[1]!.closeGate.resolve(); const leases = await Promise.all([bPending, cPending]);
    assert.equal(f.sessions.length, 3); assert.equal(f.sessions[2]!.dispatched, 1);
    for (const lease of leases) lease.release();
});

for (const invalidation of ['forceNew', 'generation'] as const) {
    test(`${invalidation} may retire a busy stale entry but preserves the physical fence`, { timeout: 5000 }, async t => {
        const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
        const next = acquireCursorRuntime(invalidation === 'forceNew' ? { ...f.options, forceNew: true }
            : { ...f.options, persistenceOwner: { global: f.reset(), scope: 0 } });
        await old.closeStarted.promise; await checkpoint(); assert.equal(f.sessions.length, 1);
        old.closeGate.resolve(); const b = await next;
        await a.retire(); a.release(); await a.cancel();
        assert.equal(f.sessions[1]!.closeCalls, 0); assert.equal(f.sessions[1]!.cancelCalls, 0);
        await dispatch(b); b.release();
    });
}

test('released lease A cannot retire the reused borrower B', async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options); a.release();
    const b = await acquireCursorRuntime(f.options); assert.equal(b.session, a.session);
    await a.retire(); await a.cancel(); a.release();
    assert.equal(f.sessions[0]!.retireCalls, 0); assert.equal(f.sessions[0]!.closeCalls, 0);
    await dispatch(b); b.release();
});

test('retire synchronously fences reuse and repeated retire/release close exactly once', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    const first = a.retire(); const again = a.retire(); a.release(); a.release();
    assert.equal(old.alive, false); assert.equal(old.closeCalls, 1);
    const next = acquireCursorRuntime(f.options); await checkpoint(); assert.equal(f.sessions.length, 1);
    old.closeGate.resolve(); await Promise.all([first, again]); const b = await next; b.release();
});

test('total monotonic deadline covers busy release then close wait without erasing its fence', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0; t.mock.method(performance, 'now', () => now);
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    const next = acquireCursorRuntime({ ...f.changed('b'), waitMs: 20 });
    const rejected = assert.rejects(next, /timed out/);
    now = 12; t.mock.timers.tick(12); a.release(); await old.closeStarted.promise;
    now = 20; t.mock.timers.tick(8); await rejected;
    assert.equal(poolStats().size, 1); assert.equal(f.sessions.length, 1); assert.equal(old.closeCalls, 1);
    old.closeGate.resolve(); await checkpoint();
    const b = await acquireCursorRuntime(f.options); await dispatch(b); b.release();
});

test('abort during close wait only removes that waiter, not fence or other acquisition', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!; a.release();
    const controller = new AbortController();
    const aborted = acquireCursorRuntime({ ...f.changed('b'), signal: controller.signal });
    const rejected = assert.rejects(aborted, /aborted/);
    await old.closeStarted.promise;
    const next = acquireCursorRuntime(f.changed('c'));
    controller.abort(); await rejected;
    assert.equal(old.closeCalls, 1); assert.equal(old.cancelCalls, 0); assert.equal(poolStats().size, 1);
    old.closeGate.resolve(); const c = await next; await dispatch(c); c.release();
});

test('abort while busy on a different key never interrupts the foreign logical owner', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    const controller = new AbortController();
    const next = acquireCursorRuntime({ ...f.changed('b'), signal: controller.signal });
    const rejected = assert.rejects(next, /aborted/); controller.abort(); await rejected;
    assert.equal(old.closeCalls, 0); assert.equal(old.retireCalls, 0); assert.equal(old.cancelCalls, 0);
    await dispatch(a); a.release();
});

test('old close completion after captured exit cannot delete a same-key successor', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    const retiring = a.retire(); const next = acquireCursorRuntime(f.options);
    old.exit(); const b = await next;
    old.closeGate.resolve(); await retiring; a.release();
    await dispatch(b); b.release();
    const c = await acquireCursorRuntime(f.options); assert.equal(c.session, b.session); c.release();
});

test('release-before-idle observes rejected retirement and preserves the fence for later waiters', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    old.idle = false;
    assert.equal(a.release(), undefined); assert.equal(old.closeCalls, 1);
    old.closeGate.reject(new Error('release reap failed')); await checkpoint();
    const controller = new AbortController();
    const refused = acquireCursorRuntime({ ...f.options, signal: controller.signal });
    const rejected = assert.rejects(refused, /aborted/);
    await checkpoint(); assert.equal(f.sessions.length, 1); assert.equal(poolStats().size, 1);
    controller.abort(); await rejected; a.release(); assert.equal(old.closeCalls, 1);
    old.exit(); const b = await acquireCursorRuntime(f.options); await dispatch(b); b.release();
});

test('synchronous close throw is a rejected retirement, never synchronous release failure or eviction', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    t.mock.method(old, 'close', () => { old.closeCalls++; throw new Error('sync close failed'); });
    const retiring = a.retire(); a.release();
    await assert.rejects(retiring, /sync close failed/);
    assert.equal(poolStats().size, 1); assert.equal(old.closeCalls, 1);
    const next = acquireCursorRuntime(f.options); await checkpoint(); assert.equal(f.sessions.length, 1);
    old.exit(); const b = await next; await dispatch(b); b.release();
});

test('cancel failure uses the same observed fence and release cannot make it reusable', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!;
    t.mock.method(old, 'cancel', async () => { old.cancelCalls++; throw new Error('cancel failed'); });
    const cancelling = a.cancel();
    const rejected = assert.rejects(cancelling, /cancel reap failed/);
    await old.closeStarted.promise; a.release();
    old.closeGate.reject(new Error('cancel reap failed')); await rejected;
    const next = acquireCursorRuntime(f.options); await checkpoint();
    assert.equal(f.sessions.length, 1); assert.equal(old.closeCalls, 1);
    old.exit(); const b = await next; await dispatch(b); b.release();
});

test('ownership invalidation during a retirement wait cannot launch after close wakes it', { timeout: 5000 }, async t => {
    const f = fixture(t), a = await acquireCursorRuntime(f.options), old = f.sessions[0]!; a.release();
    const next = acquireCursorRuntime(f.changed('b'));
    const rejected = assert.rejects(next, /ownership invalidated/);
    await old.closeStarted.promise; f.reset(); old.closeGate.resolve(); await rejected;
    assert.equal(f.sessions.length, 1); assert.equal(old.dispatched, 0);
});
