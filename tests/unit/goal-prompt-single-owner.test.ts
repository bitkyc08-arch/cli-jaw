// 260610 prompt slim phase 2 — single-owner contract.
// Each goal/PABCD rule area lives in exactly one prompt source:
//   goal-mode behavior rules → continuation prompt (src/goal/heartbeat.ts)
//   PABCD gate override      → continuation PABCD OVERRIDE block only
//   PABCD transition guide   → builder '## PABCD Orchestration Guide' + dev-pabcd skill
// Plan: devlog/_plan/260610_prompt_injection_redesign/10_goal_pabcd_prompt_slim_plan.md

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGoalContinuation } from '../../src/goal/heartbeat.ts';
import { setGoal, resetGoalStore } from '../../src/goal/store.ts';
import { setState, resetState } from '../../src/orchestrator/state-machine.ts';

const root = join(import.meta.dirname, '..', '..');
const a1Src = readFileSync(join(root, 'src/prompt/templates/a1-system.md'), 'utf8');
const smSrc = readFileSync(join(root, 'src/orchestrator/state-machine.ts'), 'utf8');
const orcSrc = readFileSync(join(root, 'src/prompt/templates/orchestration.md'), 'utf8');

function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

function cleanup(): void {
    resetState('default');
    resetGoalStore();
}

test('GSO-001: A-1 keeps the goal CLI list plus a continuation pointer only', () => {
    assert.ok(a1Src.includes('## Goal System'), 'goal CLI command list stays in A-1');
    assert.ok(a1Src.includes('[goal-continuation]'), 'A-1 points at the continuation prompt');
    assert.ok(!a1Src.includes('### Goal Mode Rules'), 'rule bullets must not live in A-1');
    assert.ok(!a1Src.includes('Goal is the supreme rule'), 'supreme-rule wording is continuation-only');
});

test('GSO-002: STATE_PROMPTS carries no goal-mode exception text', () => {
    assert.equal(count(smSrc, 'EXCEPTION — Goal mode'), 0,
        'goal-mode gate override is single-owned by the continuation PABCD OVERRIDE');
});

test('GSO-003: base continuation prompt states each canonical rule once, under budget', () => {
    cleanup();
    try {
        setGoal('single-owner: base measurement');
        const res = buildGoalContinuation();
        const p = res.prompt ?? '';
        assert.equal(res.shouldContinue, true);
        assert.equal(count(p, '--- Stop/Pause Audit ---'), 1, 'stop/pause audit owned once');
        assert.equal(count(p, 'documentation + implementation + verification evidence bundle'), 1,
            'evidence bundle definition owned once');
        assert.equal(count(p, 'independent objective reviewer'), 1, 'reviewer rule owned once');
        // devlog 260624_goal_work_phase_pabcd_loop, Slice 6: base prompt (IDLE) carries the
        // multi-phase re-entry rule so a completed cycle does not look like the whole goal.
        assert.equal(count(p, 'MULTI-PHASE LOOP'), 1, 'multi-phase loop re-entry rule owned once in base prompt');
        assert.ok(p.includes('Do not treat one completed cycle as the whole goal'), 'base prompt must warn against one-cycle=whole-goal');
        assert.ok(p.length < 5500, `base continuation is ${p.length} chars — over the 5,500 budget`);
    } finally {
        cleanup();
    }
});

test('GSO-004: PABCD-state continuation keeps the OVERRIDE block once, under budget', () => {
    cleanup();
    try {
        setGoal('single-owner: pabcd measurement');
        setState('B');
        const res = buildGoalContinuation();
        const p = res.prompt ?? '';
        assert.equal(count(p, 'GOAL IS THE SUPREME RULE — PABCD OVERRIDE'), 1, 'override block present once');
        assert.equal(count(p, 'Do not advance a PABCD-phase within the current cycle unless'), 1, 'phase gate rule owned once');
        // devlog 260624_goal_work_phase_pabcd_loop, Slice 6: override block must carry the
        // work-phase=full-cycle model + anti-skip exactly once each.
        assert.equal(count(p, 'ONE WORK-PHASE = ONE FULL PABCD CYCLE'), 1, 'work-phase=full-cycle rule owned once');
        assert.equal(count(p, 'WORK-PHASE BOUNDARY'), 1, 'work-phase boundary rule owned once');
        assert.equal(count(p, 'FAITHFUL EXECUTION (anti-skip)'), 1, 'anti-skip rule owned once');
        assert.ok(p.length < 7400, `PABCD-B continuation is ${p.length} chars — over the 7,400 budget`);
    } finally {
        cleanup();
    }
});

test('GSO-005: orchestration.md defers transition rules to the PABCD guide owners', () => {
    assert.ok(!orcSrc.includes('How to transition phases'),
        'transition command table is owned by the builder PABCD guide');
    assert.ok(orcSrc.includes('PABCD Orchestration Guide'), 'stub must point at the guide section');
    assert.match(orcSrc, /timeout[^\n]{0,40}600000/, 'dispatch timeout directive stays (MD-009)');
    assert.ok(orcSrc.includes('cli-jaw orchestrate I|P|A|B|C|D'), 'transition entrypoint summary stays');
});
