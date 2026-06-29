// P37-CU: STATIC_EMPLOYEES + Control runtime hints + dispatch resolution.
// Matches devlog/_plan/computeruse/37_revisions_and_integration.md §C.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    STATIC_EMPLOYEES,
    findStaticEmployee,
    checkRuntimeHints,
    checkModelSupport,
    resolveDispatchableEmployee,
} from '../../src/core/employees.ts';

const ROOT = process.cwd();

test('P37-CU-001: Control static employee is defined with Codex + darwin hint', () => {
    const control = findStaticEmployee('Control');
    assert.ok(control, 'Control must be in STATIC_EMPLOYEES');
    assert.equal(control!.cli, 'codex');
    assert.equal(control!.runtimeHints?.requiresDarwin, true);
});

test('P37-CU-002: Control carries desktop-control + screen-capture (vision-click absorbed)', () => {
    // vision-click is no longer a separate active skill for Control — the
    // desktop-control skill's reference/vision-click.md covers routing, and
    // the `cli-jaw browser vision-click` command encapsulates the
    // low-level recipe. See 37_revisions_and_integration.md §G.
    const control = findStaticEmployee('control'); // case-insensitive
    assert.ok(control);
    for (const skill of ['desktop-control', 'screen-capture']) {
        assert.ok(control!.skills.includes(skill), `missing skill: ${skill}`);
    }
    assert.ok(!control!.skills.includes('vision-click'),
        'vision-click should be absorbed into desktop-control, not a separate Control skill');
});

test('P37-CU-003: Control is preferred-for-long-sessions, NOT exclusive', () => {
    const control = findStaticEmployee('Control')!;
    assert.equal(control.delegation?.mode, 'preferred_for_long_sessions');
    assert.equal(control.delegation?.boss_may_self_serve, true);
});

test('P37-CU-004: Control defers non-GUI tasks back to Boss', () => {
    const control = findStaticEmployee('Control')!;
    assert.deepEqual(control.defer, { when: 'not-gui-automation', back_to: 'Boss' });
});

test('P37-CU-005: checkRuntimeHints fails when requiresDarwin but platform is linux', () => {
    const control = findStaticEmployee('Control')!;
    const result = checkRuntimeHints(control, 'linux');
    assert.ok(result.fail.length > 0, 'expected at least one fail on linux');
    assert.match(result.fail.join('\n'), /darwin|macOS|linux/i);
});

test('P37-CU-006: resolveDispatchableEmployee returns static row with synthetic id', () => {
    const res = resolveDispatchableEmployee('Control', []);
    assert.ok(res, 'Control must resolve from static employees');
    assert.equal(res!.source, 'static');
    assert.equal(res!.row.name, 'Control');
    assert.equal(res!.row.cli, 'codex');
    assert.match(String(res!.row.id), /^static:/);
    assert.ok(res!.spec, 'spec must accompany static resolution');
});

test('P37-CU-007: DB row wins over static when names collide', () => {
    const dbRows = [{
        id: 'db-row-123',
        name: 'Control',
        cli: 'claude',
        model: 'sonnet',
        role: 'overridden by user',
    }];
    const res = resolveDispatchableEmployee('Control', dbRows);
    assert.ok(res);
    assert.equal(res!.source, 'db');
    assert.equal(res!.row.id, 'db-row-123');
    assert.equal(res!.row.cli, 'claude');
});

test('P37-CU-008: unknown employee returns null', () => {
    const res = resolveDispatchableEmployee('Nonexistent', []);
    assert.equal(res, null);
});

test('P37-CU-010: desktop-control skill includes control-workflow reference', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const refPath = path.join(
        import.meta.dirname, '..', '..', 'skills_ref', 'desktop-control', 'reference', 'control-workflow.md',
    );
    assert.ok(fs.existsSync(refPath), `missing: ${refPath}`);
    const content = fs.readFileSync(refPath, 'utf8');
    assert.match(content, /Control workflow/, 'control-workflow.md must contain "Control workflow"');
});

test('P37-CU-009: STATIC_EMPLOYEES has no duplicate names', () => {
    const names = STATIC_EMPLOYEES.map((e) => e.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, 'STATIC_EMPLOYEES has duplicate names');
});

test('checkModelSupport: scaffold returns empty result for all inputs (Spark handled by args.ts, not dispatch)', () => {
    // Spark's reasoning-param incompatibility is enforced at argv-build time (args.ts isCodexSparkModel),
    // so the dispatch-level checkModelSupport has no active rules for Spark. Scaffold kept for future policies.
    assert.deepEqual(checkModelSupport('codex', 'gpt-5.3-codex-spark', {}), { fail: [], warn: [] });
    assert.deepEqual(checkModelSupport('codex', 'gpt-5.4', {}), { fail: [], warn: [] });
    assert.deepEqual(checkModelSupport('claude', 'sonnet', {}), { fail: [], warn: [] });
    assert.deepEqual(checkModelSupport(null, 'gpt-5.4'), { fail: [], warn: [] });
    assert.deepEqual(checkModelSupport('codex', null), { fail: [], warn: [] });
});

test('employee cli/model updates clear stale employee session', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/employees.ts'), 'utf8');
    assert.match(src, /clearEmployeeSessionIfResumeKeyChanged/);
    assert.match(src, /const before = db\.prepare\('SELECT \* FROM employees WHERE id = \?'\)/);
    assert.match(src, /clearEmployeeSessionIfResumeKeyChanged\(employeeId, before, emp\)/);
    assert.match(src, /\/api\/employees\/sessions\/reset/);
    assert.match(src, /resetEmployeeSessions\(\)/);
});

test('employee create/reset defaults use ocx-aware model resolver', () => {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'src/routes/employees.ts'), 'utf8');
    const coreSrc = fs.readFileSync(path.join(ROOT, 'src/core/employees.ts'), 'utf8');
    assert.match(routeSrc, /import \{ resolveCliDefaultModel \} from '\.\.\/cli\/opencodex-models\.js'/);
    assert.match(routeSrc, /app\.post\('\/api\/employees', requireAuth, async \(req, res\) =>/);
    assert.match(routeSrc, /await resolveCliDefaultModel\(cli\)/);
    assert.match(routeSrc, /app\.post\('\/api\/employees\/reset', requireAuth, async \(_req, res\) =>/);
    assert.match(routeSrc, /await seedDefaultEmployees\(\{ reset: true, notify: true \}\)/);
    assert.doesNotMatch(routeSrc, /CLI_REGISTRY\[cli/);
    assert.match(coreSrc, /import \{ resolveCliDefaultModel \} from '\.\.\/cli\/opencodex-models\.js'/);
    assert.match(coreSrc, /export async function seedDefaultEmployees/);
    assert.match(coreSrc, /const defaultModel = await resolveCliDefaultModel\(cli\)/);
    assert.doesNotMatch(coreSrc, /CLI_REGISTRY\[cli/);
});

test('dispatch clears mismatched employee resume key before attempting resume', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/orchestrator/distribute.ts'), 'utf8');
    assert.match(src, /clearStaleEmployeeSessionIfResumeKeyMismatch\(empId,\s*empSession/);
    assert.match(src, /!clearedStaleResumeKey[\s\S]*?isSessionPersistingCli/);
});

test('employee CLI supports list and honest help text', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin/commands/employee.ts'), 'utf8');
    assert.match(src, /cli-jaw employee list \[--port 3457\] \[--json\]/);
    assert.match(src, /cli-jaw employee sessions-reset \[--port 3457\]/);
    assert.match(src, /case 'list'/);
    assert.match(src, /case 'sessions-reset'/);
    assert.match(src, /\/api\/employees\/sessions\/reset/);
    assert.match(src, /\/api\/employees/);
    assert.match(src, /values\.json/);
    assert.doesNotMatch(src, /default 5 profiles/);
});
