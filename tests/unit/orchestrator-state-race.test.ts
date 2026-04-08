import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import { getCtx, getState, resetState, setState } from '../../src/orchestrator/state-machine.ts';

beforeEach(() => { resetState(); });

test('OSR-001: reset during agent execution does not restore stale P state', async () => {
    setState('P', {
        originalPrompt: 'investigate stale state',
        workingDir: null,
        plan: null,
        workerResults: [],
        origin: 'test',
    });

    await orchestrate('investigate stale state', {
        origin: 'test',
        _skipClear: true,
        _skipInsert: true,
        _spawnAgent: () => ({
            promise: (async () => {
                await Promise.resolve();
                resetState();
                return { text: 'Plan output from stale P run', code: 0 };
            })(),
        }),
    } as any);

    assert.equal(getState(), 'IDLE');
    assert.equal(getCtx(), null);
});

test('OSR-002: phase advance during agent execution preserves advanced state and ctx', async () => {
    const ctx = {
        originalPrompt: 'advance after plan approval',
        workingDir: null,
        plan: 'Approved plan from P',
        workerResults: [],
        origin: 'test',
    };
    setState('P', ctx);

    await orchestrate('advance after plan approval', {
        origin: 'test',
        _skipClear: true,
        _skipInsert: true,
        _spawnAgent: () => ({
            promise: (async () => {
                await Promise.resolve();
                setState('A', ctx);
                return { text: 'Stale planning response that must not overwrite A', code: 0 };
            })(),
        }),
    } as any);

    assert.equal(getState(), 'A');
    assert.equal(getCtx()?.plan, 'Approved plan from P');
    assert.equal(getCtx()?.originalPrompt, 'advance after plan approval');
});
