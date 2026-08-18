/**
 * #380 regressions:
 * - loaded must mean "a process is believed to run" (pidfile ownership), not
 *   "autostart artifacts exist" - a Startup .cmd owns no process.
 * - The wrapper must execute chcp 65001 before any line carrying the home
 *   path; cmd.exe parses BOM-less batch files in the OEM codepage, and a BOM
 *   fuses onto @ECHO OFF (exit 9009).
 * - verifyOwnershipAt reads the probed home's pidfile, unlike verifyOwnership
 *   which reads the module-frozen PIDFILE_PATH.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyOwnershipAt, defaultLifecycleDeps } from '../../src/core/instance-lifecycle.ts';

const onWindows = process.platform === 'win32';

test('WLH-001: verifyOwnershipAt reads the probed home, not the process home', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-wlh-'));
    try {
        // Empty foreign home: must answer no-pidfile for THAT home even though
        // this process's own CLI_JAW_HOME may have a live pidfile.
        assert.equal(verifyOwnershipAt(home, defaultLifecycleDeps).status, 'no-pidfile');
        // A pidfile for a different home inside the probed home reads foreign.
        writeFileSync(join(home, 'jaw.pid.json'), JSON.stringify({
            pid: process.pid, port: 3457, home: 'C:\\somewhere\\else',
            version: '0.0.0', startedAt: { value: '1', source: 'windows-filetime' },
        }));
        assert.equal(verifyOwnershipAt(home, defaultLifecycleDeps).status, 'foreign');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('WLH-002: generated wrapper survives a non-UTF-8 parent codepage', { skip: !onWindows }, () => {
    // Reproduce the r4 experiment as a regression: a wrapper-shaped .cmd with a
    // non-ASCII path must echo it back intact when executed after chcp 437.
    const dir = mkdtempSync(join(tmpdir(), 'jaw-wlh-cmd-'));
    const marker = 'HOME-한글-OK';
    const wrapper = join(dir, 'wrapper.cmd');
    try {
        writeFileSync(wrapper, [
            '@ECHO OFF',
            'chcp 65001 >nul',
            `REM path: ${marker}`,
            `ECHO ${marker}`,
        ].join('\r\n') + '\r\n');
        const probe = join(dir, 'probe.cmd');
        writeFileSync(probe, `@ECHO OFF\r\nchcp 437 >nul\r\ncall "${wrapper}"\r\n`);
        const r = spawnSync('cmd.exe', ['/d', '/s', '/c', probe], { encoding: 'utf8', timeout: 15000 });
        assert.equal(r.status, 0);
        assert.ok((r.stdout ?? '').includes(marker), `stdout lost the marker: ${JSON.stringify(r.stdout)}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('WLH-003: buildWrapper output places chcp before the home-carrying lines', () => {
    const src = readFileSync(new URL('../../src/manager/windows-service.ts', import.meta.url), 'utf8');
    const chcp = src.indexOf("'chcp 65001 >nul'");
    const rem = src.indexOf('REM cli-jaw autostart wrapper');
    assert.ok(chcp !== -1, 'chcp line missing from buildWrapper');
    assert.ok(rem !== -1, 'wrapper REM header moved; update this test');
    assert.ok(chcp < rem, 'chcp must precede the REM lines carrying the home path');
});
