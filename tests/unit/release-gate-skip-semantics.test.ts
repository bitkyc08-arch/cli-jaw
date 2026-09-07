/**
 * Skip-vs-require semantics for the two artifact-dependent release gates.
 *
 * Both gates were added to stop "the file exists, ship it" from counting as
 * proof, and both originally hard-failed whenever `process.env.CI` was set.
 * That reasoning did not survive contact with the workflows: `node-tests` runs
 * `npm ci --ignore-scripts` at the root only, so `electron/node_modules` and
 * `electron/sidecar/server` are never created there. The gates demanded
 * artifacts that context cannot produce and turned every pull request red.
 *
 * The fix keys the requirement on the caller instead of the environment. These
 * tests pin both directions, because the failure mode is silent in each one: a
 * gate that always skips is dead code that reports green, and a gate that
 * always fails blocks all CI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const nativeLoad = path.join(repoRoot, 'scripts', 'check-native-load.cjs');
const sidecarSmoke = path.join(repoRoot, 'scripts', 'check-sidecar-smoke.mjs');

/** Exit 3 is the scripts' "nothing was probed" signal. */
const EXIT_SKIPPED = 3;

type ProbeResult = { status: number; output: string; stdout: string; stderr: string };

async function runNode(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<ProbeResult> {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, retired = false, closed = false;
    let failure: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => {
        if (retired || child.exitCode !== null || child.signalCode !== null) return;
        try { if (!child.kill(name)) retired = true; } catch { retired = true; }
    };
    const stop = (reason: string) => {
        failure ??= reason;
        signal('SIGTERM');
        escalation ??= setTimeout(() => signal('SIGKILL'), 1000);
    };
    child.once('exit', () => { retired = true; });
    child.once('error', error => { retired = true; failure ??= error.message; });
    const receive = (chunk: string, stream: 'stdout' | 'stderr') => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) { stop('output overflow'); return; }
        if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', chunk => receive(chunk, 'stdout'));
    child.stderr.setEncoding('utf8').on('data', chunk => receive(chunk, 'stderr'));
    const timer = setTimeout(() => stop('probe timeout'), 5000);
    let boundary: ReturnType<typeof setTimeout>;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        boundary = setTimeout(() => {
            failure ??= 'child close unproven';
            child.stdout.destroy(); child.stderr.destroy(); child.unref();
            resolve({ code: null, signal: null });
        }, 7500);
        child.once('close', (code, sig) => { retired = true; closed = true; resolve({ code, signal: sig }); });
    });
    clearTimeout(timer); clearTimeout(boundary!); clearTimeout(escalation);
    assert.equal(closed, true, `retain unclosed fixture: ${cwd}`);
    assert.equal(failure, undefined, `${failure}: fixture retained at ${cwd}`);
    assert.equal(result.signal, null);
    assert.notEqual(result.code, null);
    return { status: result.code!, stdout, stderr, output: stdout + stderr };
}

/**
 * Run a probe from a throwaway directory so the developer's real
 * `electron/node_modules` cannot make an absent-artifact assertion pass by
 * accident, and strip inherited requirement flags so a shell that exported one
 * cannot flip the expected outcome.
 */
async function runProbe(
    script: string,
    args: string[] | ((cwd: string) => string[]) = [],
    env: Record<string, string> = {},
    inspect?: (cwd: string, result: ProbeResult) => void,
): Promise<ProbeResult> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-gate-skip-'));
    let cleanable = true;
    try {
        const base = { ...process.env };
        delete base['JAW_GATE_REQUIRE_NATIVE'];
        delete base['JAW_GATE_REQUIRE_SIDECAR'];
        delete base['CI'];
        delete base['NODE_OPTIONS'];
        const argv = typeof args === 'function' ? args(cwd) : args;
        cleanable = false;
        const result = await runNode(cwd, [script, ...argv], { ...base, ...env });
        inspect?.(cwd, result);
        cleanable = true;
        return result;
    } finally {
        if (cleanable) fs.rmSync(cwd, { recursive: true, force: true });
    }
}

describe('artifact-dependent gates skip honestly instead of failing CI', () => {
    it('check-native-load reports SKIPPED under plain CI when electron deps are absent', async () => {
        const r = await runProbe(nativeLoad, [], { CI: '1' });
        assert.equal(r.status, EXIT_SKIPPED, `expected skip, got ${r.status}: ${r.output}`);
        assert.match(r.output, /nothing probed/);
    });

    it('check-sidecar-smoke reports SKIPPED under plain CI when the bundle is absent', async () => {
        const r = await runProbe(sidecarSmoke, [], { CI: '1' });
        assert.equal(r.status, EXIT_SKIPPED, `expected skip, got ${r.status}: ${r.output}`);
        assert.match(r.output, /skipping smoke/);
    });
});

describe('the same gates still fail when a caller requires a real probe', () => {
    it('JAW_GATE_REQUIRE_NATIVE=1 turns an absent addon into a failure', async () => {
        const r = await runProbe(nativeLoad, [], { JAW_GATE_REQUIRE_NATIVE: '1' });
        assert.equal(r.status, 1, `expected failure, got ${r.status}: ${r.output}`);
        assert.match(r.output, /JAW_GATE_REQUIRE_NATIVE=1/);
    });

    it('JAW_GATE_REQUIRE_SIDECAR=1 turns an absent bundle into a failure', async () => {
        const r = await runProbe(sidecarSmoke, [], { JAW_GATE_REQUIRE_SIDECAR: '1' });
        assert.equal(r.status, 1, `expected failure, got ${r.status}: ${r.output}`);
        assert.match(r.output, /required a real smoke test/);
    });

    it('an explicit --server-root is itself a requirement, as bundle-sidecar.sh relies on', async () => {
        const r = await runProbe(sidecarSmoke, cwd => ['--server-root', path.join(cwd, 'absent-sidecar')]);
        assert.equal(r.status, 1, `expected failure, got ${r.status}: ${r.output}`);
        assert.match(r.output, /required a real smoke test/);
    });

    it('--server-root without a value is rejected rather than silently resolved', async () => {
        const r = await runProbe(sidecarSmoke, ['--server-root']);
        assert.equal(r.status, 2, `expected usage error, got ${r.status}: ${r.output}`);
    });
});

describe('the native probe drives each platform shell with its own syntax', () => {
    it('uses cmd.exe /c on Windows instead of the POSIX -c it once passed', () => {
        const source = fs.readFileSync(nativeLoad, 'utf8');
        // cmd.exe treats `-c` as a bad argument and prints usage, so the probe
        // would have blamed spawn-helper for a healthy addon. This gate only
        // runs on Windows during desktop-release, where nobody would have been
        // watching for a false negative.
        assert.match(source, /isWin \? \['\/d', '\/s', '\/c', 'echo jaw-pty-ok'\] : \['-c', 'echo jaw-pty-ok'\]/);
    });
});

describe('the release-gates wrapper keeps reporting a skip as a skip', () => {
    it('does not dress an unprobed gate up as a substantive pass', () => {
        const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'release-gates.mjs'), 'utf8');
        assert.match(source, /SKIPPED — electron\/node_modules absent, nothing probed/);
        assert.match(source, /SKIPPED — sidecar not bundled, nothing imported/);
    });

    for (const status of [3, 0, 1, 2, null]) {
        it(`real wrapper classifies child status ${status ?? 'null/ETIMEDOUT'} independently of success text`, async () => {
            const wrapper = path.join(repoRoot, 'scripts', 'release-gates.mjs');
            const successDetail = 'bundled sidecar imports its critical entry surfaces';
            const r = await runProbe('--require', cwd => {
                const preload = path.join(cwd, 'wrapper-preload.cjs');
                const receipt = path.join(cwd, 'calls.json');
                fs.writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const calls = [];
cp.spawnSync = (command, args, options) => {
    if (calls.length !== 0 || command !== 'node' || !Array.isArray(args)
        || args.length !== 1 || args[0] !== 'scripts/check-sidecar-smoke.mjs'
        || options.cwd !== ${JSON.stringify(repoRoot)} || options.timeout !== 120000
        || options.encoding !== 'utf8' || options.stdio !== 'pipe' || options.shell) {
        process.stderr.write('UNEXPECTED_WRAPPER_SPAWN'); process.exit(86);
    }
    calls.push({command, args, cwd: options.cwd, timeout: options.timeout});
    fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(calls));
    return { status: ${JSON.stringify(status)}, signal: ${status === null ? "'SIGTERM'" : 'null'},
        stdout: 'FAKE_SUCCESS: all critical modules imported', stderr: ${status === null ? "'fixture ETIMEDOUT'" : "'fixture diagnostic'"},
        error: ${status === null ? "Object.assign(new Error('fixture timeout'), {code: 'ETIMEDOUT'})" : 'undefined'} };
};
syncBuiltinESMExports();
`);
                return [preload, wrapper, 'sidecar-smoke'];
            }, {}, cwd => {
                assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, 'calls.json'), 'utf8')), [{
                    command: 'node', args: ['scripts/check-sidecar-smoke.mjs'], cwd: repoRoot, timeout: 120000,
                }]);
            });
            assert.doesNotMatch(r.output, /UNEXPECTED_WRAPPER_SPAWN/);
            assert.equal(r.status, status === 3 || status === 0 ? 0 : 1, r.output);
            if (status === 3) {
                assert.match(r.output, /\[PASS\] gate:sidecar-smoke/);
                assert.match(r.output, /SKIPPED — sidecar not bundled, nothing imported/);
                assert.ok(!r.output.includes(successDetail));
            } else if (status === 0) {
                assert.match(r.output, /\[PASS\] gate:sidecar-smoke/);
                assert.ok(r.output.includes(successDetail));
                assert.doesNotMatch(r.output, /SKIPPED/);
            } else {
                assert.match(r.output, /\[FAIL\] gate:sidecar-smoke/);
                assert.doesNotMatch(r.output, /\[PASS\]|All 1 gate\(s\) passed|SKIPPED/);
                assert.match(r.output, /FAKE_SUCCESS/);
                assert.ok(!r.output.includes(successDetail));
                if (status === null) assert.match(r.output, /fixture ETIMEDOUT/);
            }
        });
    }
});
