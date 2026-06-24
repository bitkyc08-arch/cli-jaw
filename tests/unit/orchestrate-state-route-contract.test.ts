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
    assert.ok(routeSrc.includes('const humanApproval = !isAgent && (force || userInitiated)'), 'route should apply human approval only for non-agent (Phase 60)');
    assert.ok(routeSrc.includes('ctxPresent: Boolean(currentCtx)'), 'route should report ctx presence');
    assert.ok(routeSrc.includes('current,'), 'route should report current state');
    assert.ok(routeSrc.includes('target: t'), 'route should report target state');
    assert.ok(routeSrc.includes('force,'), 'route should report force flag');
    assert.ok(routeSrc.includes('userInitiated,'), 'route should report userInitiated flag');
});

test('ORC-STATE-010: route distinguishes agent (boss-token) from human actor', () => {
    assert.ok(routeSrc.includes("req.headers['x-jaw-boss-token']"), 'route should read the boss-token header');
    assert.ok(routeSrc.includes('verifyBossToken(bossTokenHeader)'), 'route should verify the boss token');
    assert.ok(routeSrc.includes("actor: isAgent ? 'agent' : 'human'"), 'route should pass actor to canTransition');
});

test('ORC-STATE-011: route reads attestation from --attest body, ctx fallback only', () => {
    assert.ok(routeSrc.includes('parsePhaseAttestationObject(req.body?.attestation)'), 'route should parse --attest body');
    assert.ok(routeSrc.includes('bodyAttestation ?? currentCtx?.pendingAttestation ?? null'), 'body attestation is SOT, ctx is fallback');
});

test('ORC-STATE-012: route forces --force only for the agent + surfaces it as discouraged', () => {
    assert.ok(routeSrc.includes('force: isAgent && force'), 'force override honored only for the agent');
    assert.ok(routeSrc.includes('do NOT use --force'), 'blocked agent reason should discourage --force');
});

test('ORC-STATE-013: route clears single-use pendingAttestation after a successful transition', () => {
    assert.ok(routeSrc.includes('pendingAttestation: null'), 'route should null pendingAttestation after success');
    assert.ok(routeSrc.includes('the just-consumed evidence is single-use'), 'route should document single-use evidence clearing');
});

test('ORC-STATE-005: state route success response also includes transition diagnostics', () => {
    assert.ok(
        routeSrc.includes('res.json({ ok: true, state: getState(scope), current, target: t, force, userInitiated, ctxPresent: Boolean(currentCtx) })'),
        'successful state transition should include current/target/force/userInitiated/ctxPresent diagnostics',
    );
});

test('ORC-STATE-006: snapshot exposes task anchor and heartbeat runtime contracts', () => {
    assert.ok(routeSrc.includes('taskAnchor: ctx.taskAnchor'), 'snapshot safeCtx should include taskAnchor');
    assert.ok(routeSrc.includes('resolvedSelection: ctx.resolvedSelection'), 'snapshot safeCtx should include resolvedSelection');
    assert.ok(routeSrc.includes('heartbeat: getHeartbeatRuntimeState()'), 'snapshot should include heartbeat runtime state');
});

test('ORC-STATE-007: D transition does not clear configured projectDirs', () => {
    const dBranchStart = routeSrc.indexOf("if (t === 'D')");
    const dBranchEnd = routeSrc.indexOf('} else {', dBranchStart);
    assert.notEqual(dBranchStart, -1, 'state route should have a D transition branch');
    assert.notEqual(dBranchEnd, -1, 'D transition branch should be followed by non-D transition setup');
    const dBranch = routeSrc.slice(dBranchStart, dBranchEnd);

    assert.ok(dBranch.includes('resetState(scope)'), 'D transition should still reset PABCD state');
    assert.ok(!dBranch.includes('clearProjectDirs'), 'D transition must preserve persistent projectDirs');
    assert.ok(!dBranch.includes("projectDirs: null"), 'D transition must not broadcast a projectDirs reset');
});

test('ORC-STATE-008: P transition pins existing context before a plan exists', () => {
    const pBranchStart = routeSrc.indexOf("if (t === 'P')");
    const iBranchStart = routeSrc.indexOf("} else if (t === 'I')", pBranchStart);
    assert.notEqual(pBranchStart, -1, 'state route should have a P transition branch');
    assert.notEqual(iBranchStart, -1, 'P branch should be followed by I branch');
    const pBranch = routeSrc.slice(pBranchStart, iBranchStart);

    assert.ok(
        pBranch.includes('let baseCtx = existingCtx'),
        'P transition should derive base context from any existing ctx, not only existing ctx with a plan',
    );
    assert.ok(
        pBranch.includes("originalPrompt: existingCtx.originalPrompt || existingCtx.interview?.request || ''"),
        'P transition should fall back to the interview request as the pinned original prompt',
    );
    assert.ok(
        pBranch.includes('workerResults: existingCtx.workerResults ?? []'),
        'P transition should normalize missing workerResults while preserving existing context',
    );
    assert.ok(
        pBranch.includes('if (current === \'I\' && existingCtx?.interview)'),
        'I -> P should preserve interview context even when interview.known is empty',
    );
    assert.ok(
        pBranch.includes('if (existingCtx.interview.known?.length)'),
        'I -> P should only build seed/report when evidence rows exist',
    );
});
