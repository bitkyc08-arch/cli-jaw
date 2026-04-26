import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canTransition } from '../../src/orchestrator/state-machine.ts';

const projectRoot = join(import.meta.dirname, '../..');
const routeSrc = readFileSync(join(projectRoot, 'src/routes/orchestrate.ts'), 'utf8');
const stateMachineSrc = readFileSync(join(projectRoot, 'src/orchestrator/state-machine.ts'), 'utf8');

test('ORC-STATE-001: force does not skip invalid phase transitions', () => {
    const result = canTransition('IDLE', 'C', { userApproved: true } as any);
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /Force cannot skip phases/);
});

test('ORC-STATE-002: userApproved only bypasses A/B and B/C gates', () => {
    assert.equal(canTransition('A', 'B', { userApproved: true } as any).ok, true);
    assert.equal(canTransition('B', 'C', { userApproved: true } as any).ok, true);
    assert.equal(canTransition('A', 'B', { auditStatus: 'fail' } as any).ok, false);
    assert.equal(canTransition('B', 'C', { verificationStatus: 'needs_fix' } as any).ok, false);
});

test('ORC-STATE-003: gate messages describe force as gate override, not phase skip', () => {
    assert.ok(stateMachineSrc.includes('explicit user approval'), 'gate messages should mention explicit user approval');
    assert.ok(stateMachineSrc.includes('use /orchestrate B'), 'A->B message should tell users direct transition is valid approval');
    assert.ok(stateMachineSrc.includes('use /orchestrate C'), 'B->C message should tell users direct transition is valid approval');
    assert.ok(stateMachineSrc.includes('override this audit gate'), 'A->B message should scope force to audit gate');
    assert.ok(stateMachineSrc.includes('override this verification gate'), 'B->C message should scope force to verification gate');
});

test('ORC-STATE-004: state route returns diagnostics on failed transition', () => {
    assert.ok(routeSrc.includes('forceMissingCtx'), 'route should detect force with missing ctx');
    assert.ok(routeSrc.includes('const userInitiated = req.body?.userInitiated === true'), 'route should accept explicit user command marker');
    assert.ok(routeSrc.includes('const hasExplicitApproval = force || userInitiated'), 'route should apply user approval without requiring --force');
    assert.ok(routeSrc.includes('ctxPresent: Boolean(currentCtx)'), 'route should report ctx presence');
    assert.ok(routeSrc.includes('current,'), 'route should report current state');
    assert.ok(routeSrc.includes('target: t'), 'route should report target state');
    assert.ok(routeSrc.includes('force,'), 'route should report force flag');
    assert.ok(routeSrc.includes('userInitiated,'), 'route should report userInitiated flag');
});

test('ORC-STATE-005: state route success response also includes transition diagnostics', () => {
    assert.ok(
        routeSrc.includes('res.json({ ok: true, state: getState(scope), current, target: t, force, userInitiated, ctxPresent: Boolean(currentCtx) })'),
        'successful state transition should include current/target/force/userInitiated/ctxPresent diagnostics',
    );
});
