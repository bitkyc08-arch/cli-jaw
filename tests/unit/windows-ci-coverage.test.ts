import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const workflow = yaml.parse(read('.github/workflows/postinstall-platform.yml'));
const nativeJob = workflow.jobs['windows-native'];

/**
 * Windows CI coverage contract (#371).
 *
 * Most win32 branches are exercised on Linux through injected fixtures, which proves
 * the logic but not that the fixtures match the platform. These assertions pin which
 * suites actually execute on a real `windows-2022` runner, and — just as important —
 * that editing those files TRIGGERS the job at all. A suite that runs in a job nothing
 * schedules is not coverage.
 */

/** Every path list across push and pull_request triggers. */
function triggerPaths(): string[] {
    const on = workflow.on ?? workflow[true];   // yaml parses bare `on:` as boolean true
    return [...(on.push?.paths ?? []), ...(on.pull_request?.paths ?? [])];
}

const WINDOWS_CRITICAL_SOURCES = [
    'src/agent/spawn.ts',
    'src/agent/spawn-env.ts',
    'src/agent/stream-text.ts',
    'src/core/windows-launch-spec.ts',
    'src/core/windows-bootstrap.ts',
    'src/core/windows-shell.ts',
    'src/core/instance-identity.ts',
    'scripts/install.ps1',
    'scripts/windows-bootstrap-manifest.json',
];

const WINDOWS_CRITICAL_SUITES = [
    'tests/unit/spawn-env.test.ts',
    'tests/unit/stream-decode-boundary.test.ts',
    'tests/unit/windows-launch-spec.test.ts',
    'tests/unit/windows-bootstrap.test.ts',
    'tests/unit/instance-identity.test.ts',
    'tests/unit/install-ps1-hardening.test.ts',
];

test('WCI-001: the native Windows job exists and is not allowed to fail', () => {
    assert.ok(nativeJob, 'a windows-native job must exist');
    assert.match(String(nativeJob['runs-on']), /^windows-/);
    // Both undefined and an explicit false are fine; anything truthy is not a gate.
    assert.notEqual(nativeJob['continue-on-error'], true, 'a lane that may fail is not a gate');
    assert.ok(
        nativeJob['continue-on-error'] === undefined || nativeJob['continue-on-error'] === false,
        `windows-native must not be advisory (got ${String(nativeJob['continue-on-error'])})`,
    );
});

test('WCI-002: every Windows-critical suite actually runs on the native runner', () => {
    // Running only on Linux proves the injected fixtures agree with themselves.
    const commands = nativeJob.steps.map((s: { run?: string }) => s.run ?? '').join('\n');
    for (const suite of WINDOWS_CRITICAL_SUITES) {
        assert.ok(commands.includes(suite), `${suite} must run on windows-2022`);
    }
});

test('WCI-003: editing a Windows-critical file triggers the job', () => {
    // A suite that runs in a job nothing schedules is not coverage. This is the
    // failure the audit found: the trigger list omitted the launcher and decoder.
    const paths = triggerPaths();
    for (const file of [...WINDOWS_CRITICAL_SOURCES, ...WINDOWS_CRITICAL_SUITES]) {
        assert.ok(paths.includes(file), `${file} must appear in the workflow trigger paths`);
    }
});

test('WCI-004: both PowerShell versions run the installer contract', () => {
    const steps = nativeJob.steps as Array<{ shell?: string; run?: string }>;
    for (const shell of ['pwsh', 'powershell']) {
        const matching = steps.filter(s => s.shell === shell && (s.run ?? '').includes('install-ps1-contract.ps1'));
        assert.ok(matching.length > 0, `no ${shell} step runs the installer contract`);
        for (const step of matching) {
            assert.equal((step as Record<string, unknown>)['continue-on-error'], undefined,
                `the ${shell} contract step must be a gate`);
        }
    }
});

test('WCI-005: the trigger lists stay in sync between push and pull_request', () => {
    // A file listed for push but not pull_request is covered only after merge,
    // which is exactly when the feedback is least useful.
    const on = workflow.on ?? workflow[true];
    const push = new Set<string>(on.push?.paths ?? []);
    const pr = new Set<string>(on.pull_request?.paths ?? []);
    for (const file of WINDOWS_CRITICAL_SOURCES) {
        assert.ok(push.has(file), `${file} missing from push triggers`);
        assert.ok(pr.has(file), `${file} missing from pull_request triggers`);
    }
});
