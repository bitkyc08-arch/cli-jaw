import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import { getCtx, getState, resetState, setState } from '../../src/orchestrator/state-machine.ts';

beforeEach(() => { resetState('default'); });
afterEach(() => { resetState('default'); });

test('OSR-001: reset during agent execution does not restore stale P state', async () => {
    setState('P', {
        originalPrompt: 'investigate stale state',
        workingDir: null,
        plan: null,
        workerResults: [],
        origin: 'test',
    }, 'default');

    await orchestrate('investigate stale state', {
        origin: 'test',
        _skipClear: true,
        _skipInsert: true,
        _spawnAgent: () => ({
            promise: (async () => {
                await Promise.resolve();
                resetState('default');
                return { text: 'Plan output from stale P run', code: 0 };
            })(),
        }),
    } as any);

    assert.equal(getState('default'), 'IDLE');
    assert.equal(getCtx('default'), null);
});

test('OSR-002: phase advance during agent execution preserves advanced state and ctx', async () => {
    const ctx = {
        originalPrompt: 'advance after plan approval',
        workingDir: null,
        plan: 'Approved plan from P',
        workerResults: [],
        origin: 'test',
    };
    setState('P', ctx, 'default');

    await orchestrate('advance after plan approval', {
        origin: 'test',
        _skipClear: true,
        _skipInsert: true,
        _spawnAgent: () => ({
            promise: (async () => {
                await Promise.resolve();
                setState('A', ctx, 'default');
                return { text: 'Stale planning response that must not overwrite A', code: 0 };
            })(),
        }),
    } as any);

    assert.equal(getState('default'), 'A');
    assert.equal(getCtx('default')?.plan, 'Approved plan from P');
    assert.equal(getCtx('default')?.originalPrompt, 'advance after plan approval');
});
