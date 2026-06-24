import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getState, setState, getCtx, resetState,
    canTransition, getPrefix, getStatePrompt, buildScopeRebindGuard,
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
    test('26. scope rebind guard is empty without interview ctx', () => {
        const ctx = { originalPrompt: 'build academy', workingDir: null, plan: null, workerResults: [], origin: 'web' };
        assert.equal(buildScopeRebindGuard(ctx), '');
    });
    test('27. scope rebind guard binds interview answers to parent goal', () => {
        const ctx = {
            originalPrompt: 'Add a one-time study-session end notifier',
            workingDir: null,
            plan: null,
            workerResults: [],
            origin: 'web',
            interview: {
                request: 'Clarify praise phrase style and storage',
                round: 2,
                known: [],
                unknown: [],
            },
        };
        const guard = buildScopeRebindGuard(ctx);
        assert.match(guard, /Scope Rebind Guard/);
        assert.match(guard, /Parent Goal: Add a one-time study-session end notifier/);
        assert.match(guard, /Interview Purpose: Clarify praise phrase style and storage/);
        assert.match(guard, /Do not reinterpret a clarification answer as a new parent task/);
    });
    test('28. P prefix includes scope rebind guard when interview ctx exists', () => {
        const ctx = {
            originalPrompt: 'Add a session-end break notification',
            workingDir: null,
            plan: null,
            workerResults: [],
            origin: 'web',
            interview: { request: 'Pick notification phrase style', round: 1, known: [], unknown: [] },
        };
        const prefix = getPrefix('P', 'user', ctx)!;
        assert.match(prefix, /PLANNING MODE/);
        assert.match(prefix, /Scope Rebind Guard/);
        assert.match(prefix, /Bind interview answers only as parameters/);
    });
});
