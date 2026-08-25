// #458: this file writes the shared `orc_state` 'default' row. tests/run.mts forks
// per file but every child inherits ONE CLI_JAW_HOME, so without an isolated home a
// concurrent file's resetState() clobbers this file's setState() mid-assertion.
// Must be the FIRST import: config.ts binds DB_PATH at module evaluation.
import '../setup/isolated-home.ts';
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

test('OSR-003: P initial turn uses pinned originalPrompt instead of continuation text', async () => {
    setState('P', {
        originalPrompt: 'Fix orchestration context drift after long interview',
        workingDir: null,
        plan: null,
        workerResults: [],
        origin: 'test',
        interview: {
            request: 'Fix orchestration context drift after long interview',
            round: 2,
            known: [],
            unknown: ['exact route contract'],
        },
    }, 'default');

    let capturedPrompt = '';

    await orchestrate('진행', {
        origin: 'test',
        _skipClear: true,
        _skipInsert: true,
        _spawnAgent: (prompt: string) => {
            capturedPrompt = prompt;
            return {
                promise: Promise.resolve({ text: 'Plan output for pinned context', code: 0 }),
            };
        },
    } as any);

    const userRequest = capturedPrompt.split('User request:\n')[1] || '';
    assert.match(userRequest, /^Fix orchestration context drift after long interview/);
    assert.doesNotMatch(userRequest, /^진행\b/);
    assert.equal(getCtx('default')?.originalPrompt, 'Fix orchestration context drift after long interview');
    assert.equal(getCtx('default')?.interview?.request, 'Fix orchestration context drift after long interview');
});
