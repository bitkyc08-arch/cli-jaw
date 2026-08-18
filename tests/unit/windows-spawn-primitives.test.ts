/**
 * #382 regressions: probe execution on detector paths, env merge key folding,
 * and graceful-vs-hard kill routing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeExec } from '../../src/core/probe-exec.ts';
import { mergeEnvWindowsSafe } from '../../src/agent/spawn-env.ts';

const onWindows = process.platform === 'win32';

test('WSP2-001: probeExec runs a .cmd shim that bare execFileSync EINVALs on', { skip: !onWindows }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-probe-'));
    const shim = join(dir, 'fake-cli.cmd');
    try {
        writeFileSync(shim, '@ECHO OFF\r\nECHO logged in as tester\r\n');
        const r = probeExec(shim, ['status']);
        assert.equal(r.status, 0, `status=${r.status} err=${r.error?.message}`);
        assert.ok(r.stdout.includes('logged in'), r.stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('WSP2-002: probeExec never throws on nonzero exit (agy contract)', { skip: !onWindows }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-probe2-'));
    const shim = join(dir, 'grumpy.cmd');
    try {
        writeFileSync(shim, '@ECHO OFF\r\nECHO usage: grumpy 1>&2\r\nEXIT /B 2\r\n');
        const r = probeExec(shim, ['--help']);
        assert.equal(r.status, 2);
        assert.ok(r.stderr.includes('usage'), r.stderr);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('WSP2-003: probeExec surfaces a missing binary as .error, not a throw', () => {
    const r = probeExec(join(tmpdir(), 'jaw-definitely-missing-binary-372.exe'), ['--version']);
    assert.notEqual(r.status, 0);
});

test('WSP2-004: mergeEnvWindowsSafe folds Path/PATH into one canonical key on win32', () => {
    const merged = mergeEnvWindowsSafe({ Path: 'C:\\base', HOME: 'h' }, { PATH: 'C:\\delta' }, 'win32');
    const pathKeys = Object.keys(merged).filter(k => k.toLowerCase() === 'path');
    assert.deepEqual(pathKeys, ['PATH']);
    assert.equal(merged['PATH'], 'C:\\delta');
    assert.equal(merged['HOME'], 'h');
});

test('WSP2-005: mergeEnvWindowsSafe keeps the base path when the delta has none', () => {
    const merged = mergeEnvWindowsSafe({ Path: 'C:\\base' }, { FOO: 'bar' }, 'win32');
    assert.equal(merged['PATH'], 'C:\\base');
    assert.equal(merged['FOO'], 'bar');
    assert.equal('Path' in merged, false);
});

test('WSP2-006: mergeEnvWindowsSafe is a plain spread on POSIX', () => {
    const merged = mergeEnvWindowsSafe({ PATH: '/usr/bin', Path: '/fake' }, { FOO: 'bar' }, 'linux');
    assert.equal(merged['PATH'], '/usr/bin');
    assert.equal(merged['Path'], '/fake');
});

test('WSP2-007: killProcessTree keeps hard-kill semantics; graceful variant exists for OwnedProcess', async () => {
    const mod = await import('../../src/agent/spawn/process-kill.ts');
    assert.equal(typeof mod.killProcessTreeGraceful, 'function');
    // Source pin: the direct-path taskkill must keep /F (no-escalation callers).
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/agent/spawn/process-kill.ts', import.meta.url), 'utf8');
    assert.match(src, /'\/PID', String\(pid\), '\/T', '\/F'/);
});
