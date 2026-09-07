import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve(import.meta.dirname, '..', '..', 'scripts', 'ci', 'aggregate-check.sh');
type Env = Partial<Record<'CHANGES_RESULT' | 'CODE_CHANGED' | 'TEST_RESULT' | 'INTEGRATION_RESULT' | 'GATES_RESULT' | 'WINDOWS_UNIT_RESULT', string>>;
const allGreen: Env = { CHANGES_RESULT: 'success', CODE_CHANGED: 'true', TEST_RESULT: 'success', INTEGRATION_RESULT: 'success', GATES_RESULT: 'success', WINDOWS_UNIT_RESULT: 'success' };

function run(env: Env) {
    const r = spawnSync('bash', [script], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr };
}

test('AGG-001: every producer success with code=true passes', () => {
    const r = run(allGreen);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /all required jobs succeeded/);
});

test('AGG-002: docs-only (code=false) accepts skipped producers', () => {
    const r = run({ ...allGreen, CODE_CHANGED: 'false', TEST_RESULT: 'skipped', INTEGRATION_RESULT: 'skipped', GATES_RESULT: 'skipped', WINDOWS_UNIT_RESULT: 'skipped' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /docs-only change/);
});

test('AGG-003: a skipped producer under code=true is a dropped job, not a pass', () => {
    for (const job of ['TEST_RESULT', 'INTEGRATION_RESULT', 'GATES_RESULT', 'WINDOWS_UNIT_RESULT'] as const) {
        const r = run({ ...allGreen, [job]: 'skipped' });
        assert.equal(r.status, 1, `${job}: ${r.out}`);
        assert.match(r.out, /skipped although change detection reported code changes/);
    }
});

test('AGG-004: failure, cancelled, empty, and unknown results always fail', () => {
    for (const value of ['failure', 'cancelled', '', 'bogus']) {
        for (const job of ['TEST_RESULT', 'INTEGRATION_RESULT', 'GATES_RESULT', 'WINDOWS_UNIT_RESULT'] as const) {
            const env = { ...allGreen, [job]: value };
            if (value === '') delete (env as Record<string, string>)[job];
            const r = run(env);
            assert.equal(r.status, 1, `${job}=${value}: ${r.out}`);
        }
    }
});

test('AGG-005: changes must be success and code must be exactly true|false', () => {
    assert.equal(run({ ...allGreen, CHANGES_RESULT: 'failure' }).status, 1);
    assert.equal(run({ ...allGreen, CHANGES_RESULT: 'skipped' }).status, 1);
    for (const code of ['', 'yes', 'TRUE', 'null']) {
        const env = { ...allGreen, CODE_CHANGED: code };
        if (code === '') delete (env as Record<string, string>).CODE_CHANGED;
        const r = run(env);
        assert.equal(r.status, 1, `code=${code}`);
        assert.match(r.out, /expected true or false/);
    }
});

