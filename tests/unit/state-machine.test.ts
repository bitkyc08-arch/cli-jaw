import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getState, setState, getCtx, resetState,
    canTransition, getPrefix, getStatePrompt,
    type OrcStateName,
} from '../../src/orchestrator/state-machine.ts';

beforeEach(() => { resetState('default'); });
afterEach(() => { resetState('default'); });

describe('PABCD state-machine', () => {
    test('1. getState() = IDLE initially', () => {
        assert.equal(getState('default'), 'IDLE');
    });
    test('2. setState P', () => {
        setState('P', undefined, 'default');
        assert.equal(getState('default'), 'P');
    });
    test('3. setState with ctx', () => {
        const ctx = { originalPrompt: 'test', workingDir: null, plan: null, workerResults: [], origin: 'web' };
        setState('P', ctx, 'default');
        assert.deepEqual(getCtx('default'), ctx);
    });
    test('4. resetState → IDLE + null', () => {
        setState('B', undefined, 'default');
        resetState('default');
        assert.equal(getState('default'), 'IDLE');
        assert.equal(getCtx('default'), null);
    });
    test('5. IDLE→P valid', () => {
        assert.equal(canTransition('IDLE', 'P').ok, true);
    });
    test('6. IDLE→B invalid', () => {
        assert.equal(canTransition('IDLE', 'B').ok, false);
    });
    test('7. P→A valid', () => {
        assert.equal(canTransition('P', 'A').ok, true);
    });
    test('8. prefix P user = Pb2', () => {
        assert.ok(getPrefix('P', 'user')!.includes('PLANNING MODE'));
    });
    test('9. prefix B user = null', () => {
        assert.equal(getPrefix('B', 'user'), null);
    });
    test('10. prefix B worker = Bb2', () => {
        assert.ok(getPrefix('B', 'worker')!.includes('IMPLEMENTATION REVIEW'));
    });
    test('11. statePrompt P not empty', () => {
        assert.ok(getStatePrompt('P').length > 0);
    });
    test('12. statePrompt INVALID = empty', () => {
        assert.equal(getStatePrompt('INVALID'), '');
    });
    test('13. statePrompt D not empty', () => {
        assert.ok(getStatePrompt('D').includes('PABCD'));
    });
    test('14. C→D and D→IDLE valid', () => {
        assert.equal(canTransition('C', 'D').ok, true);
        assert.equal(canTransition('D', 'IDLE').ok, true);
    });
    test('15. D → reset → IDLE', () => {
        setState('D', undefined, 'default');
        resetState('default');
        assert.equal(getState('default'), 'IDLE');
    });
    test('16. P→D invalid (must go through C)', () => {
        assert.equal(canTransition('P', 'D').ok, false);
        assert.equal(canTransition('A', 'D').ok, false);
        assert.equal(canTransition('B', 'D').ok, false);
    });
    test('17. setState P with ctx preserves context', () => {
        const ctx = { originalPrompt: 'build settings', workingDir: null, plan: null, workerResults: [], origin: 'web' };
        setState('P', ctx, 'default');
        assert.equal(getState('default'), 'P');
        const saved = getCtx('default');
        assert.equal(saved!.originalPrompt, 'build settings');
        assert.equal(saved!.origin, 'web');
    });
    test('18. setState P without ctx clears stale context', () => {
        const ctx = { originalPrompt: 'stale build', workingDir: null, plan: 'stale plan', workerResults: [], origin: 'web' };
        setState('B', ctx, 'default');

        setState('P', undefined, 'default');

        assert.equal(getState('default'), 'P');
        assert.equal(getCtx('default'), null);
    });
    test('19. IDLE→I valid', () => {
        assert.equal(canTransition('IDLE', 'I').ok, true);
    });
    test('20. I→P valid', () => {
        assert.equal(canTransition('I', 'P').ok, true);
    });
    test('21. I→IDLE valid (reset path)', () => {
        assert.equal(canTransition('I', 'IDLE').ok, true);
    });
    test('22. I→B invalid (must go through P)', () => {
        assert.equal(canTransition('I', 'B').ok, false);
    });
    test('23. prefix I user = Ip (INTERVIEW MODE)', () => {
        assert.ok(getPrefix('I', 'user')!.includes('INTERVIEW MODE'));
    });
    test('24. statePrompt I not empty', () => {
        assert.ok(getStatePrompt('I').length > 0);
    });
    test('25. setState I preserves interview ctx', () => {
        const ctx = {
            originalPrompt: 'build academy',
            workingDir: null,
            plan: null,
            workerResults: [],
            origin: 'web',
            interview: { request: 'build academy', round: 1, known: [], unknown: [] },
        };
        setState('I', ctx, 'default');
        assert.equal(getState('default'), 'I');
        const saved = getCtx('default');
        assert.deepEqual(saved!.interview, ctx.interview);
    });
    // --- Loop / multi-pass work-phase prompt contract (devlog 260624_goal_work_phase_pabcd_loop, Slice 6) ---
    test('26. I prompt has Loop / Multi-Pass section recognizing loop/루프 + Phase 0', () => {
        const i = getStatePrompt('I');
        assert.ok(i.includes('Loop / Multi-Pass Tasks'), 'I prompt missing Loop / Multi-Pass section');
        assert.ok(i.includes('"loop"') && i.includes('"루프"'), 'I prompt must recognize loop/루프 keyword');
        assert.ok(i.includes('one per work-phase'), 'I prompt must assume one PABCD cycle per work-phase');
        assert.ok(i.includes('design-only PABCD pass (Phase 0)'), 'I prompt missing design-only Phase 0 mention');
    });
    test('27. P prompt pre-plans full slice map + design-only Phase 0 for loop tasks', () => {
        const p = getStatePrompt('P');
        assert.ok(p.includes('loop / multi-pass task'), 'P prompt missing loop/multi-pass guidance');
        assert.ok(p.includes('pre-plan the FULL work-phase slice map'), 'P prompt must pre-plan full slice map');
        assert.ok(p.includes('design-only PABCD pass (Phase 0)'), 'P prompt missing design-only Phase 0 mention');
    });
    test('28. D prompt scopes summary to work-phase, not whole goal', () => {
        const d = getStatePrompt('D');
        assert.ok(d.includes('This PABCD cycle is finished'), 'D must scope to the cycle, not "all phases finished"');
        assert.ok(d.includes('in this work-phase'), 'D summary must be work-phase scoped');
        assert.ok(!d.includes('All phases finished'), 'D must not declare all phases finished unconditionally');
    });
    test('29. D prompt re-enters P for next work-phase when a goal is active', () => {
        const d = getStatePrompt('D');
        assert.ok(d.includes('a goal is active'), 'D missing goal-active branch');
        assert.ok(d.includes('cli-jaw orchestrate P'), 'D must point next work-phase to orchestrate P');
        assert.ok(d.includes('D → IDLE → P'), 'D must state the legal re-entry path D → IDLE → P');
        assert.ok(d.includes('Do not declare the whole goal done yet'), 'D must not declare whole goal done after one cycle');
    });

    // --- Phase 60: agent evidence gate (GateInput) on canTransition ---
    test('30. agent path: P→A/A→B/B→C/C→D blocked without attestation', () => {
        for (const [f, t] of [['P', 'A'], ['A', 'B'], ['B', 'C'], ['C', 'D']] as const) {
            const r = canTransition(f, t, null, { actor: 'agent' });
            assert.equal(r.ok, false, `agent ${f}→${t} must be blocked without attestation`);
            assert.match(r.reason!, /attestation|--attest/i);
        }
    });
    test('31. agent path: passes with a well-formed attestation (narrative did)', () => {
        for (const [f, t] of [['P', 'A'], ['A', 'B'], ['B', 'C']] as const) {
            const att = { from: f, to: t, did: 'did specific real work this phase', raw: '{}' };
            assert.equal(canTransition(f, t, null, { actor: 'agent', attestation: att }).ok, true, `agent ${f}→${t}`);
        }
    });
    test('32. agent path: C→D needs checkOutput', () => {
        const noOut = { from: 'C' as const, to: 'D' as const, did: 'ran checks', raw: '{}' };
        assert.equal(canTransition('C', 'D', null, { actor: 'agent', attestation: noOut }).ok, false);
        const withOut = { from: 'C' as const, to: 'D' as const, did: 'ran checks', checkOutput: '49/49 pass', raw: '{}' };
        assert.equal(canTransition('C', 'D', null, { actor: 'agent', attestation: withOut }).ok, true);
    });
    test('33. agent path: hidden --force overrides the gate', () => {
        assert.equal(canTransition('A', 'B', null, { actor: 'agent', force: true }).ok, true);
    });
    test('34. agent path: any→I never requires attestation', () => {
        assert.equal(canTransition('B', 'I', null, { actor: 'agent' }).ok, true);
        assert.equal(canTransition('C', 'B', null, { actor: 'agent' }).ok, true); // reject route
    });
    test('35. human/legacy path unchanged: A→B still uses ctx auditStatus', () => {
        // No gate arg ⇒ legacy behavior; auditStatus!=='pass' blocks.
        assert.equal(canTransition('A', 'B', { auditStatus: 'fail' } as never).ok, false);
        assert.equal(canTransition('A', 'B', { auditStatus: 'pass' } as never).ok, true);
        assert.equal(canTransition('A', 'B', { userApproved: true } as never).ok, true);
        // Human actor explicitly ⇒ still legacy (not the agent form-gate).
        assert.equal(canTransition('A', 'B', { userApproved: true } as never, { actor: 'human' }).ok, true);
    });
});
