import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';

import { hasChildExited, killProcessTreeIfAlive } from '../../src/agent/spawn/process-kill.js';

const projectRoot = join(import.meta.dirname, '..', '..');

test('hasChildExited reports a running child as alive', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
    try {
        assert.equal(hasChildExited(child), false);
    } finally {
        child.kill('SIGKILL');
        await once(child, 'exit');
    }
});

test('hasChildExited reports an exited child as exited', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'exit');

    assert.equal(hasChildExited(child), true);
});

test('killed is not a liveness test, which is why the guard uses exit state', async () => {
    // A process can have received a signal (killed === true) and still be running,
    // so escalation must not key off `killed`.
    const child = spawn(process.execPath, [
        '-e',
        'process.on("SIGTERM", () => {}); setTimeout(()=>{}, 60000);',
    ]);
    try {
        await new Promise(resolve => setTimeout(resolve, 200));
        child.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 200));

        assert.equal(child.killed, true, 'a signal was delivered');
        assert.equal(hasChildExited(child), false, 'but the process is still running');
    } finally {
        child.kill('SIGKILL');
        await once(child, 'exit');
    }
});

test('escalation is skipped once the child has exited', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'exit');

    // The PID may already belong to someone else, so this must be a no-op rather
    // than a kill aimed at a recycled PID.
    const strangerPid = 2147483646;
    assert.doesNotThrow(() => killProcessTreeIfAlive(child, strangerPid));
});

test('every delayed SIGKILL in spawn.ts is guarded by a liveness check', () => {
    const lines = readFileSync(join(projectRoot, 'src', 'agent', 'spawn.ts'), 'utf8').split('\n');
    const unguarded: number[] = [];

    lines.forEach((line, index) => {
        if (!/SIGKILL/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        const context = lines.slice(Math.max(0, index - 7), index + 2).join(' ');
        const delayed = /setTimeout/.test(context);
        const guarded = /IfAlive|!\s*\w+\.killed|exitCode\s*===\s*null/.test(context);
        if (delayed && !guarded) unguarded.push(index + 1);
    });

    assert.deepEqual(
        unguarded,
        [],
        `delayed SIGKILL without a liveness guard can kill a recycled PID (lines: ${unguarded.join(', ')})`,
    );
});

/**
 * The duplicate-registration reaper arrived from a different branch than the
 * liveness guards, so the two met for the first time at merge. It carried its
 * own copy of the `killed`-as-liveness mistake in two places, and a textually
 * clean merge would have kept both.
 */
test('the duplicate-registration reaper decides liveness by exit state, not by killed', () => {
    const source = readFileSync(join(projectRoot, 'src', 'agent', 'spawn.ts'), 'utf8');
    const start = source.indexOf('function registerActiveProcess');
    assert.notEqual(start, -1, 'registerActiveProcess must exist');
    const region = source.slice(start, start + 2600);

    // Case 1: an already-exited child must be dropped without a blind SIGKILL,
    // because the OS may have handed its PID to something else by then.
    assert.match(
        region,
        /if \(hasChildExited\(prev\)\) \{/,
        'the overwrite branch must ask whether prev actually exited',
    );

    // Case 2: killed === true with both exit fields null means a SIGTERM-trapping
    // child is still alive, and escalation must still reach it. Keying the branch
    // on `killed` would delete it from the map and never schedule the escalation,
    // leaving a process that stop/shutdown/restart can no longer find.
    assert.doesNotMatch(
        region,
        /prev\.exitCode !== null \|\| prev\.killed/,
        'prev.killed only records signal delivery and must not stand in for liveness',
    );

    // Case 3: the grace-period escalation must be liveness-checked. This used
    // to assert one literal `setTimeout(... killProcessTreeIfAlive ...)` shape,
    // which broke the moment the reaper moved onto the shared OwnedProcess
    // owner even though the guarantee was unchanged. Assert the GUARANTEE —
    // that the escalation is delegated to something that re-checks the child —
    // rather than the spelling of the delegation.
    assert.match(
        region,
        /ownProcess\(prev,[\s\S]*?graceMs:\s*DUP_REGISTRATION_KILL_GRACE_MS[\s\S]*?\.terminate\(/,
        'the reaper must delegate to the owner with the documented grace',
    );
    assert.doesNotMatch(
        region,
        /setTimeout\([\s\S]{0,200}killProcessTree\(/,
        'no hand-rolled escalation may survive beside the owner',
    );
});

/**
 * The behavioral counterpart to the source checks above: OwnedProcess is the
 * single place every spawn.ts escalation now routes through, so its liveness
 * guarantee is what actually protects a recycled PID.
 */
test('the owner refuses to escalate onto a PID whose child already exited', async () => {
    const { OwnedProcess } = await import('../../src/agent/spawn/process-kill.js');
    const { EventEmitter } = await import('node:events');

    const child = new EventEmitter() as unknown as import('node:child_process').ChildProcess;
    (child as { pid?: number }).pid = 31337;
    (child as { exitCode: number | null }).exitCode = null;
    (child as { signalCode: string | null }).signalCode = null;
    // A CLI that traps SIGTERM: `killed` is set, but it is still running.
    (child as { killed?: boolean }).killed = true;

    const signals: Array<{ pid: number; signal: string }> = [];
    let escalate: (() => void) | null = null;
    const owned = new OwnedProcess(child, {
        terminateTree: (pid, signal = 'SIGTERM') => { signals.push({ pid, signal }); },
        setTimer: ((fn: () => void) => { escalate = fn; return { unref() { return this; } } as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout,
    });

    owned.terminate('duplicate-registration');
    assert.deepEqual(signals, [{ pid: 31337, signal: 'SIGTERM' }]);

    // Still alive despite `killed` — escalation must reach it.
    escalate!();
    assert.deepEqual(signals[1], { pid: 31337, signal: 'SIGKILL' });

    // Now it exits, and a second escalation must NOT fire: the PID may belong
    // to someone else, and killProcessTree walks children.
    signals.length = 0;
    (child as { exitCode: number | null }).exitCode = 0;
    escalate!();
    assert.deepEqual(signals, [], 'a recycled PID must never be signalled');
});
