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
