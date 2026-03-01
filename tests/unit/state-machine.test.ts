import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getState, setState, getCtx, resetState,
    canTransition, getPrefix, getStatePrompt,
    type OrcStateName,
} from '../../src/orchestrator/state-machine.ts';

beforeEach(() => { resetState(); });

describe('PABCD state-machine', () => {
    test('1. getState() = IDLE initially', () => {
        assert.equal(getState(), 'IDLE');
    });
    test('2. setState P', () => {
        setState('P');
        assert.equal(getState(), 'P');
    });
    test('3. setState with ctx', () => {
        const ctx = { originalPrompt: 'test', plan: null, workerResults: [], origin: 'web' };
        setState('P', ctx);
        assert.deepEqual(getCtx(), ctx);
    });
    test('4. resetState → IDLE + null', () => {
        setState('B');
        resetState();
        assert.equal(getState(), 'IDLE');
        assert.equal(getCtx(), null);
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
        assert.ok(getStatePrompt('D').includes('PABCD COMPLETE'));
    });
    test('14. C→D and D→IDLE valid', () => {
        assert.equal(canTransition('C', 'D'), true);
        assert.equal(canTransition('D', 'IDLE'), true);
    });
    test('15. D → reset → IDLE', () => {
        setState('D');
        resetState();
        assert.equal(getState(), 'IDLE');
    });
    test('16. P→D invalid (must go through C)', () => {
        assert.equal(canTransition('P', 'D'), false);
        assert.equal(canTransition('A', 'D'), false);
        assert.equal(canTransition('B', 'D'), false);
    });
    test('17. setState P with ctx preserves context', () => {
        const ctx = { originalPrompt: 'build settings', plan: null, workerResults: [], origin: 'web' };
        setState('P', ctx);
        assert.equal(getState(), 'P');
        const saved = getCtx();
        assert.equal(saved!.originalPrompt, 'build settings');
        assert.equal(saved!.origin, 'web');
    });
});
