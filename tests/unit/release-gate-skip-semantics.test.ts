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
import { spawnSync } from 'node:child_process';
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

/**
 * Run a probe from a throwaway directory so the developer's real
 * `electron/node_modules` cannot make an absent-artifact assertion pass by
 * accident, and strip inherited requirement flags so a shell that exported one
 * cannot flip the expected outcome.
 */
function runProbe(
    script: string,
    args: string[] = [],
    env: Record<string, string> = {},
): { status: number; output: string } {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-gate-skip-'));
    try {
        const base = { ...process.env };
        delete base['JAW_GATE_REQUIRE_NATIVE'];
        delete base['JAW_GATE_REQUIRE_SIDECAR'];
        delete base['CI'];
        const r = spawnSync('node', [script, ...args], {
            cwd,
            encoding: 'utf8',
            env: { ...base, ...env },
        });
        return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}

describe('artifact-dependent gates skip honestly instead of failing CI', () => {
    it('check-native-load reports SKIPPED under plain CI when electron deps are absent', () => {
        const r = runProbe(nativeLoad, [], { CI: '1' });
        assert.equal(r.status, EXIT_SKIPPED, `expected skip, got ${r.status}: ${r.output}`);
        assert.match(r.output, /nothing probed/);
    });

    it('check-sidecar-smoke reports SKIPPED under plain CI when the bundle is absent', () => {
        const r = runProbe(sidecarSmoke, [], { CI: '1' });
        assert.equal(r.status, EXIT_SKIPPED, `expected skip, got ${r.status}: ${r.output}`);
        assert.match(r.output, /skipping smoke/);
    });
});

describe('the same gates still fail when a caller requires a real probe', () => {
    it('JAW_GATE_REQUIRE_NATIVE=1 turns an absent addon into a failure', () => {
        const r = runProbe(nativeLoad, [], { JAW_GATE_REQUIRE_NATIVE: '1' });
        assert.equal(r.status, 1, `expected failure, got ${r.status}: ${r.output}`);
        assert.match(r.output, /JAW_GATE_REQUIRE_NATIVE=1/);
    });

    it('JAW_GATE_REQUIRE_SIDECAR=1 turns an absent bundle into a failure', () => {
        const r = runProbe(sidecarSmoke, [], { JAW_GATE_REQUIRE_SIDECAR: '1' });
        assert.equal(r.status, 1, `expected failure, got ${r.status}: ${r.output}`);
        assert.match(r.output, /required a real smoke test/);
    });

    it('an explicit --server-root is itself a requirement, as bundle-sidecar.sh relies on', () => {
        const missing = path.join(os.tmpdir(), 'jaw-gate-skip-absent-sidecar');
        const r = runProbe(sidecarSmoke, ['--server-root', missing]);
        assert.equal(r.status, 1, `expected failure, got ${r.status}: ${r.output}`);
        assert.match(r.output, /required a real smoke test/);
    });

    it('--server-root without a value is rejected rather than silently resolved', () => {
        const r = runProbe(sidecarSmoke, ['--server-root']);
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
});
