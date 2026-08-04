import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { gracefulShutdown } from '../../electron/src/main/lib/jaw-spawn.js';

/**
 * Regression test for the D1 orphan-server defect (260803 unit, 010 phase).
 *
 * The dev `jaw` shim is a `/bin/sh` script that launches node WITHOUT exec(),
 * so the real dashboard server is a grandchild. Signalling only `child.pid`
 * kills the shim and leaves the server holding its port; the next launch then
 * walks to the next port and spawns a second full server.
 *
 * This reproduces that topology with a grandchild that ignores SIGTERM, which
 * is exactly the case the SIGKILL escalation exists for. Before the fix the
 * escalation was blind: once the shim died, `pgrep -P <shimPid>` returned
 * nothing, so there was no target left to kill.
 */

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('gracefulShutdown kills a SIGTERM-ignoring grandchild behind a /bin/sh shim', async (t) => {
    if (process.platform === 'win32') {
        t.skip('POSIX process-group semantics only');
        return;
    }

    const dir = mkdtempSync(join(tmpdir(), 'jaw-orphan-'));
    const pidFile = join(dir, 'grandchild.pid');
    const serverScript = join(dir, 'server.mjs');
    const shim = join(dir, 'shim.sh');

    // Grandchild: reports its pid, then refuses to die on SIGTERM.
    writeFileSync(serverScript, [
        `import { writeFileSync } from 'node:fs';`,
        `process.on('SIGTERM', () => {});`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `setInterval(() => {}, 1000);`,
    ].join('\n'));

    // Shim: launches node WITHOUT exec, so node is a grandchild of the caller.
    writeFileSync(shim, [
        '#!/bin/sh',
        `"${process.execPath}" "${serverScript}" &`,
        'wait',
    ].join('\n'));
    chmodSync(shim, 0o755);

    const child = spawn('/bin/sh', [shim], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });

    try {
        let grandchildPid = 0;
        for (let i = 0; i < 50 && !grandchildPid; i += 1) {
            await sleep(100);
            try {
                const { readFileSync } = await import('node:fs');
                grandchildPid = Number(readFileSync(pidFile, 'utf8').trim()) || 0;
            } catch {
                // not written yet
            }
        }

        assert.ok(grandchildPid > 0, 'grandchild should have reported its pid');
        assert.ok(isAlive(grandchildPid), 'grandchild should be running before shutdown');

        await gracefulShutdown(child, 500);

        // gracefulShutdown must not resolve while the tree is still alive.
        await sleep(300);
        assert.equal(
            isAlive(grandchildPid),
            false,
            'grandchild must be dead after gracefulShutdown — a surviving server keeps its port '
            + 'and forces the next launch onto a new port, stacking full servers',
        );
    } finally {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        rmSync(dir, { recursive: true, force: true });
    }
});
