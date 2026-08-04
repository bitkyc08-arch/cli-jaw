import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CAPABILITY_PROBE_OUTER_DEADLINE_MS,
    probeCodexAppCapability,
} from '../../src/cli/capability-probe.ts';
import { buildCapabilitySpawnSpec } from '../../src/cli/capability-probe-worker.ts';

function fixture(dir: string, name: string, body: string): string {
    const path = join(dir, `${name}.cjs`);
    writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, 'utf8');
    chmodSync(path, 0o755);
    return path;
}

function isGone(pid: number): boolean {
    try { process.kill(pid, 0); return false; } catch { return true; }
}

async function waitUntilGone(pid: number): Promise<boolean> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (isGone(pid)) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return isGone(pid);
}

test('capability probe reports exit 0 and non-zero without exposing output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-probe-test-'));
    try {
        const ok = fixture(dir, 'ok', "process.stdout.write('help text'); process.exit(0);");
        const bad = fixture(dir, 'bad', "process.stderr.write('private diagnostics'); process.exit(7);");
        assert.deepEqual(probeCodexAppCapability(ok), {
            ok: true,
            exitCode: 0,
            signal: null,
            timedOut: false,
            outputLimitExceeded: false,
            reason: 'ready',
        });
        const failure = probeCodexAppCapability(bad);
        assert.equal(failure.ok, false);
        assert.equal(failure.exitCode, 7);
        assert.equal(failure.reason, 'exit-nonzero');
        assert.equal('stdout' in failure, false);
        assert.equal('stderr' in failure, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('combined stdout and stderr above 64 KiB fails closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-probe-test-'));
    try {
        const noisy = fixture(dir, 'noisy', [
            "process.on('SIGTERM', () => {});",
            "process.stdout.write(Buffer.alloc(40 * 1024, 'a'));",
            "process.stderr.write(Buffer.alloc(25 * 1024, 'b'));",
            'setInterval(() => {}, 1_000);',
        ].join('\n'));
        const result = probeCodexAppCapability(noisy);
        assert.equal(result.ok, false);
        assert.equal(result.outputLimitExceeded, true);
        assert.equal(result.reason, 'output-limit');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('non-terminating probe and its pipe-holding descendant are killed within the hard bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-probe-test-'));
    const pidFile = join(dir, 'pids.json');
    try {
        const hanging = fixture(dir, 'hanging', [
            "const { spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: ['ignore', 'ignore', 'pipe'] });",
            "fs.writeFileSync(process.env.TEST_DESCENDANT_PID_FILE, JSON.stringify({ parent: process.pid, child: child.pid }));",
            "process.on('SIGTERM', () => {});",
            'setInterval(() => {}, 1_000);',
        ].join('\n'));
        const previous = process.env['TEST_DESCENDANT_PID_FILE'];
        process.env['TEST_DESCENDANT_PID_FILE'] = pidFile;
        const started = Date.now();
        const result = probeCodexAppCapability(hanging);
        const elapsed = Date.now() - started;
        if (previous === undefined) delete process.env['TEST_DESCENDANT_PID_FILE'];
        else process.env['TEST_DESCENDANT_PID_FILE'] = previous;

        assert.equal(result.ok, false);
        assert.equal(result.timedOut, true);
        assert.ok(elapsed < CAPABILITY_PROBE_OUTER_DEADLINE_MS, `probe took ${elapsed}ms`);
        const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { parent: number; child: number };
        assert.equal(await waitUntilGone(pids.parent), true, `parent ${pids.parent} survived`);
        assert.equal(await waitUntilGone(pids.child), true, `descendant ${pids.child} survived`);
    } finally {
        delete process.env['TEST_DESCENDANT_PID_FILE'];
        rmSync(dir, { recursive: true, force: true });
    }
});

test('Windows shim adapter uses shell for .cmd-like paths but direct argv for .exe', () => {
    const shim = buildCapabilitySpawnSpec({ binary: 'C:\\tools\\codex.cmd', platform: 'win32' }, {});
    const exe = buildCapabilitySpawnSpec({ binary: 'C:\\tools\\codex.exe', platform: 'win32' }, {});
    assert.deepEqual(shim.args, ['app-server', '--help']);
    assert.equal(shim.options.shell, true);
    assert.deepEqual(exe.args, ['app-server', '--help']);
    assert.equal(exe.options.shell, undefined);
});
