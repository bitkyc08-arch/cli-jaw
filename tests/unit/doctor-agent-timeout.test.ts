import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The watchdog ends a turn that stops reporting progress, and nothing told the
// operator the deadline was tunable — a 933s research turn read as the model
// giving up (#405). These run the real command: asserting on the source text
// missed that the no-global-value case dropped its own caveat.

const repoRoot = join(import.meta.dirname, '..', '..');
const repoTsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = join(repoRoot, 'bin', 'cli-jaw.ts');

function doctorTimeoutDetail(settings: Record<string, unknown>): string {
    // tsx is a devDependency. No conditional skip: a nested skip would mark the
    // inner test skipped and let this one pass in the one environment where it
    // never ran.
    assert.ok(existsSync(repoTsx), `repo-local tsx is required: ${repoTsx}`);
    const home = mkdtempSync(join(tmpdir(), 'jaw-agent-timeout-'));
    try {
        const settingsPath = join(home, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify(settings));
        chmodSync(settingsPath, 0o600);
        // spawnSync, not execFileSync: doctor exits non-zero whenever ANY check
        // is warn/error, and a throwaway home has several.
        const run = spawnSync(repoTsx, [cliEntry, '--home', home, 'doctor', '--json'], {
            cwd: repoRoot, encoding: 'utf8', timeout: 60000,
            env: { ...process.env, NO_COLOR: '1' },
        });
        assert.ok(run.stdout, `doctor printed nothing: ${run.stderr || run.error}`);
        const checks = JSON.parse(run.stdout).checks as Array<{ name: string; detail: string }>;
        const row = checks.find(c => c.name === '에이전트 타임아웃');
        assert.ok(row, 'doctor must report the agent timeout');
        return row!.detail;
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

test('DAT-001: an unset deadline says where to set it', () => {
    const detail = doctorTimeoutDetail({ cli: 'cursor' });
    assert.match(detail, /600초 \(기본값\)/);
    assert.match(detail, /agentTimeout\.absoluteMs/);
});

test('DAT-002: a per-CLI override wins over the global value', () => {
    // Reading only the global here would answer "111초" for an instance that
    // actually runs with 222.
    const detail = doctorTimeoutDetail({
        cli: 'cursor',
        agentTimeout: { absoluteMs: 111_000, cursor: { absoluteMs: 222_000 } },
    });
    assert.match(detail, /222초/);
    assert.match(detail, /cursor/);
});

test('DAT-003: with no settings.cli, the caveat survives — with or without a global value', () => {
    // The runtime picks the CLI by probing readiness at load time, which this
    // process cannot reproduce. Naming a guess would report an override for a
    // CLI that may never run, so it says what it does and does not know.
    const withGlobal = doctorTimeoutDetail({
        agentTimeout: { absoluteMs: 111_000, cursor: { absoluteMs: 222_000 }, grok: { absoluteMs: 333_000 } },
    });
    assert.match(withGlobal, /111초/, 'the global value is what applies absent a known CLI');
    assert.match(withGlobal, /실행 CLI를 알 수 없습니다/);
    assert.match(withGlobal, /cursor/);
    assert.match(withGlobal, /grok/);

    // The instance most in need of the caveat was the one told a bare default.
    const noGlobal = doctorTimeoutDetail({
        agentTimeout: { cursor: { absoluteMs: 222_000 }, grok: { absoluteMs: 333_000 } },
    });
    assert.match(noGlobal, /600초 \(기본값/);
    assert.match(noGlobal, /실행 CLI를 알 수 없습니다/);
    assert.match(noGlobal, /cursor/);
});

test('DAT-004: a configured zero is reported, not mistaken for unset', () => {
    const detail = doctorTimeoutDetail({ cli: 'cursor', agentTimeout: { absoluteMs: 0 } });
    assert.match(detail, /^0초/, `a configured 0 must not read as the default: ${detail}`);
});

// A diagnostic has to survive the settings it is diagnosing. `projectDirs`
// comes from raw JSON, and a numeric entry made `path.resolve` throw — taking
// the entire `--json` report down instead of reporting the broken config (#404).
test('DAT-005: a malformed config still produces a report', () => {
    assert.ok(existsSync(repoTsx), `repo-local tsx is required: ${repoTsx}`);
    const home = mkdtempSync(join(tmpdir(), 'jaw-doctor-malformed-'));
    try {
        const settingsPath = join(home, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({ projectDirs: [42, null, ''], workingDir: 7 }));
        chmodSync(settingsPath, 0o600);
        const run = spawnSync(repoTsx, [cliEntry, '--home', home, 'doctor', '--json'], {
            cwd: repoRoot, encoding: 'utf8', timeout: 60000,
            env: { ...process.env, NO_COLOR: '1' },
        });
        assert.ok(run.stdout, `doctor printed nothing: ${run.stderr || run.error}`);
        const payload = JSON.parse(run.stdout);
        assert.ok(Array.isArray(payload.checks), 'the report must still be a report');
        // The usable root survives; the junk entries are skipped rather than fatal.
        assert.ok(Array.isArray(payload.messaging?.sendRoots));
        assert.equal(payload.messaging.sendRoots.length, 1, 'only JAW_HOME resolves here');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
