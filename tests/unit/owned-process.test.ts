// OwnedProcess lifetime contract. Uses the injectable terminator/timer seams so
// no real process is spawned: the point is the state machine, not the OS.
import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { OwnedProcess, ownProcess, hasChildExited, killProcessTreeIfAlive } from '../../src/agent/spawn/process-kill.js';

/** Minimal ChildProcess stand-in: Node sets exactly one of exitCode/signalCode. */
function fakeChild(pid: number | undefined = 4242): ChildProcess {
    const c = new EventEmitter() as unknown as ChildProcess;
    (c as { pid?: number }).pid = pid;
    (c as { exitCode: number | null }).exitCode = null;
    (c as { signalCode: string | null }).signalCode = null;
    return c;
}

function exit(child: ChildProcess, code = 0): void {
    (child as { exitCode: number | null }).exitCode = code;
    (child as unknown as EventEmitter).emit('exit', code, null);
}

type Call = { pid: number; signal: NodeJS.Signals };

function harness(pid: number | undefined = 4242) {
    const calls: Call[] = [];
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const child = fakeChild(pid);
    const owned = new OwnedProcess(child, {
        terminateTree: (p: number, s: NodeJS.Signals = 'SIGTERM') => { calls.push({ pid: p, signal: s }); },
        setTimer: ((fn: () => void, ms: number) => {
            const t = { fn, ms, cleared: false };
            timers.push(t);
            return { unref() { return this; } } as unknown as NodeJS.Timeout;
        }) as unknown as typeof setTimeout,
        clearTimer: (() => { const t = timers[timers.length - 1]; if (t) t.cleared = true; }) as unknown as typeof clearTimeout,
    });
    return { calls, timers, child, owned };
}

test('terminate walks the tree with SIGTERM and schedules escalation', () => {
    const { calls, timers, owned } = harness();
    owned.terminate('cancel');
    assert.deepStrictEqual(calls, [{ pid: 4242, signal: 'SIGTERM' }]);
    assert.strictEqual(timers.length, 1, 'escalation must be scheduled');
    assert.strictEqual(owned.reason, 'cancel');
});

test('escalation kills the tree when the child is still alive', () => {
    const { calls, timers, owned } = harness();
    owned.terminate('timeout');
    timers[0]!.fn();
    assert.deepStrictEqual(calls[1], { pid: 4242, signal: 'SIGKILL' });
});

test('escalation does NOT fire after the child exits', () => {
    // The PID may already be recycled; killProcessTree walks children, so a
    // blind escalation would take down an unrelated tree.
    const { calls, timers, child, owned } = harness();
    owned.terminate('timeout');
    exit(child);
    timers[0]!.fn();
    assert.strictEqual(calls.length, 1, 'must not signal a possibly-recycled pid');
});

test('child exit completes the owner and clears the pending timer', () => {
    const { timers, child, owned } = harness();
    owned.terminate('shutdown');
    exit(child);
    assert.strictEqual(owned.state, 'complete');
    assert.ok(timers[0]!.cleared, 'pending escalation must be cleared');
});

test('the first termination reason wins and repeats are ignored', () => {
    const { calls, owned } = harness();
    owned.terminate('stall');
    owned.terminate('cancel');
    owned.terminate('shutdown');
    assert.strictEqual(owned.reason, 'stall');
    assert.strictEqual(calls.length, 1, 'terminate must be idempotent');
});

test('terminate after completion is a no-op', () => {
    const { calls, child, owned } = harness();
    exit(child);
    owned.terminate('cancel');
    assert.strictEqual(calls.length, 0);
});

test('an already-exited child is never signalled', () => {
    const { calls, child, owned } = harness();
    (child as { exitCode: number | null }).exitCode = 0;
    owned.terminate('cancel');
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(owned.state, 'complete');
});

test('a child with no pid completes instead of signalling', () => {
    // A spawn that failed before the OS assigned a pid: there is nothing to
    // signal, and guessing would be worse than doing nothing.
    const calls: Call[] = [];
    const child = fakeChild();
    (child as { pid?: number }).pid = undefined;
    const owned = new OwnedProcess(child, {
        terminateTree: (p, s = 'SIGTERM') => { calls.push({ pid: p, signal: s }); },
    });
    owned.terminate('startup-failed');
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(owned.state, 'complete');
});

test('a SIGKILL policy schedules no escalation', () => {
    const calls: Call[] = [];
    const timers: unknown[] = [];
    const child = fakeChild();
    const owned = new OwnedProcess(child, {
        policy: () => ({ initialSignal: 'SIGKILL', graceMs: 2_000 }),
        terminateTree: (p, s = 'SIGTERM') => { calls.push({ pid: p, signal: s }); },
        setTimer: ((fn: () => void) => { timers.push(fn); return { unref() { return this; } } as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout,
    });
    owned.terminate('stall');
    assert.deepStrictEqual(calls, [{ pid: 4242, signal: 'SIGKILL' }]);
    assert.strictEqual(timers.length, 0, 'SIGKILL needs no escalation');
});

test('a null grace disables escalation', () => {
    const timers: unknown[] = [];
    const child = fakeChild();
    const owned = new OwnedProcess(child, {
        policy: () => ({ initialSignal: 'SIGTERM', graceMs: null }),
        terminateTree: () => { /* noop */ },
        setTimer: ((fn: () => void) => { timers.push(fn); return { unref() { return this; } } as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout,
    });
    owned.terminate('completion');
    assert.strictEqual(timers.length, 0);
});

test('the pid is captured once and never retargeted', () => {
    // If the owner re-read child.pid at escalation time it could follow a
    // reassigned pid; capturing at construction is what prevents that.
    const { calls, timers, child, owned } = harness();
    owned.terminate('timeout');
    (child as { pid?: number }).pid = 9999;
    timers[0]!.fn();
    assert.strictEqual(calls[1]!.pid, 4242);
});

test('ownProcess is memoized so owners cannot compete', () => {
    const child = fakeChild();
    const a = ownProcess(child);
    const b = ownProcess(child);
    assert.strictEqual(a, b, 'two owners would install competing escalation timers');
});

test('an error event completes the owner', () => {
    const child = fakeChild();
    const owned = ownProcess(child);
    (child as unknown as EventEmitter).emit('error', new Error('spawn failed'));
    assert.strictEqual(owned.state, 'complete');
});

// ── existing helpers must keep their contract ────────────────────

test('hasChildExited treats killed as NOT a liveness answer', () => {
    const child = fakeChild();
    (child as { killed?: boolean }).killed = true;
    assert.strictEqual(hasChildExited(child), false, 'a signalled process may still run');
    exit(child);
    assert.strictEqual(hasChildExited(child), true);
});

test('killProcessTreeIfAlive accepts an injected terminator', () => {
    const calls: Call[] = [];
    const child = fakeChild();
    killProcessTreeIfAlive(child, 4242, (p, s = 'SIGTERM') => { calls.push({ pid: p, signal: s }); });
    assert.deepStrictEqual(calls, [{ pid: 4242, signal: 'SIGKILL' }]);
    calls.length = 0;
    exit(child);
    killProcessTreeIfAlive(child, 4242, (p, s = 'SIGTERM') => { calls.push({ pid: p, signal: s }); });
    assert.strictEqual(calls.length, 0, 'exited child must not be signalled');
});
