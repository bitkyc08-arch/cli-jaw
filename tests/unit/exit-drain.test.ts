import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { releaseChildOutputAfterExit } from '../../src/agent/spawn/exit-drain.js';

/** Wait for `close`, or report that it never arrived. */
function closeWithin(child: ReturnType<typeof spawn>, ms: number): Promise<number | null> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        child.once('close', () => {
            clearTimeout(timer);
            resolve(Date.now());
        });
    });
}

test('a detached descendant holding the pipes cannot wedge the turn forever', async () => {
    // The child exits immediately but leaves a grandchild that inherited stdout,
    // so 'close' would otherwise never fire and the turn would never settle.
    const child = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'],
              { stdio: 'inherit', detached: true }).unref();
        process.exit(0);
    `]);

    const cleanup = releaseChildOutputAfterExit(child);
    try {
        const closed = await closeWithin(child, 5_000);
        assert.notEqual(closed, null, 'close must fire once the drain releases the pipes');
    } finally {
        cleanup();
    }
});

test('without the drain the same child never closes', async () => {
    // Pins the premise of the fix: if this ever starts closing on its own, the
    // drain is no longer load-bearing and this suite should be revisited.
    const child = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'],
              { stdio: 'inherit', detached: true }).unref();
        process.exit(0);
    `]);

    try {
        const closed = await closeWithin(child, 2_000);
        assert.equal(closed, null, 'close is expected to be blocked by the descendant');
    } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.kill('SIGKILL');
    }
});

test('output written just before exit is not truncated', async () => {
    // The drain must not cut short tails: a child that prints and exits in the
    // same tick still has to deliver everything it wrote.
    const lines = 500;
    const child = spawn(process.execPath, ['-e', `
        for (let i = 0; i < ${lines}; i++) console.log('line-' + i);
        process.exit(0);
    `]);

    const cleanup = releaseChildOutputAfterExit(child);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });

    try {
        await once(child, 'close');
        assert.match(out, /line-0\n/, 'first line must survive');
        assert.match(out, new RegExp(`line-${lines - 1}\\n`), 'last line must survive');
        assert.equal(out.trim().split('\n').length, lines, 'no line may be dropped');
    } finally {
        cleanup();
    }
});

test('cleanup leaves no listeners behind on a normal run', async () => {
    const child = spawn(process.execPath, ['-e', 'console.log("done")']);
    const cleanup = releaseChildOutputAfterExit(child);

    await once(child, 'close');
    cleanup();

    assert.equal(child.listenerCount('exit'), 0, 'exit listener must be removed');
    assert.equal(child.stdout?.listenerCount('data') ?? 0, 0, 'stdout data listener must be removed');
});
