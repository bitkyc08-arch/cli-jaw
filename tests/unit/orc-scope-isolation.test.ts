import test from 'node:test';
import assert from 'node:assert/strict';
import { getState, getCtx, resetState, setState } from '../../src/orchestrator/state-machine.ts';

test('OSI-001: state is isolated per scope', () => {
    resetState('local:/tmp/a');
    resetState('telegram:1:/tmp/a');

    setState('B', {
        originalPrompt: 'build a',
        workingDir: '/tmp/a',
        scopeId: 'local:/tmp/a',
        plan: 'plan a',
        workerResults: [],
        origin: 'web',
    }, 'local:/tmp/a');

    setState('P', {
        originalPrompt: 'build b',
        workingDir: '/tmp/a',
        scopeId: 'telegram:1:/tmp/a',
        plan: null,
        workerResults: [],
        origin: 'telegram',
        chatId: 1,
    }, 'telegram:1:/tmp/a');

    assert.equal(getState('local:/tmp/a'), 'B');
    assert.equal(getState('telegram:1:/tmp/a'), 'P');
    assert.equal(getCtx('local:/tmp/a')?.originalPrompt, 'build a');
    assert.equal(getCtx('telegram:1:/tmp/a')?.originalPrompt, 'build b');
});

test('OSI-002: resetState only affects its own scope', () => {
    resetState('local:/tmp/a');
    resetState('local:/tmp/b');

    setState('A', {
        originalPrompt: 'task a',
        workingDir: '/tmp/a',
        scopeId: 'local:/tmp/a',
        plan: null,
        workerResults: [],
        origin: 'web',
    }, 'local:/tmp/a');

    setState('B', {
        originalPrompt: 'task b',
        workingDir: '/tmp/b',
        scopeId: 'local:/tmp/b',
        plan: null,
        workerResults: [],
        origin: 'web',
    }, 'local:/tmp/b');

    resetState('local:/tmp/a');

    assert.equal(getState('local:/tmp/a'), 'IDLE');
    assert.equal(getState('local:/tmp/b'), 'B');
});

test('OSI-003: scopeId is persisted in ctx', () => {
    resetState('local:/tmp/x');

    setState('P', {
        originalPrompt: 'test',
        workingDir: '/tmp/x',
        scopeId: 'local:/tmp/x',
        plan: null,
        workerResults: [],
        origin: 'web',
    }, 'local:/tmp/x');

    const ctx = getCtx('local:/tmp/x');
    assert.equal(ctx?.scopeId, 'local:/tmp/x');
});
