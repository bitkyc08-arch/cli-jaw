import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getState, setState, getCtx, resetState,
    canTransition, getPrefix, getStatePrompt,
    type OrcStateName,
} from '../../src/orchestrator/state-machine.ts';

beforeEach(() => { resetState('default'); });

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
        assert.equal(canTransition('IDLE', 'P'), true);
    });
    test('6. IDLE→B invalid', () => {
        assert.equal(canTransition('IDLE', 'B'), false);
    });
    test('7. P→A valid', () => {
        assert.equal(canTransition('P', 'A'), true);
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
        assert.equal(canTransition('C', 'D'), true);
        assert.equal(canTransition('D', 'IDLE'), true);
    });
    test('15. D → reset → IDLE', () => {
        setState('D', undefined, 'default');
        resetState('default');
        assert.equal(getState('default'), 'IDLE');
    });
    test('16. P→D invalid (must go through C)', () => {
        assert.equal(canTransition('P', 'D'), false);
        assert.equal(canTransition('A', 'D'), false);
        assert.equal(canTransition('B', 'D'), false);
    });
    test('17. setState P with ctx preserves context', () => {
        const ctx = { originalPrompt: 'build settings', workingDir: null, plan: null, workerResults: [], origin: 'web' };
        setState('P', ctx, 'default');
        assert.equal(getState('default'), 'P');
        const saved = getCtx('default');
        assert.equal(saved!.originalPrompt, 'build settings');
        assert.equal(saved!.origin, 'web');
    });
});
