import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildApprovedPlanPromptBlock,
    orchestrate,
} from '../../src/orchestrator/pipeline.ts';
import {
    getStatePrompt,
    resetState,
    setState,
    type OrcContext,
    type OrcStateName,
} from '../../src/orchestrator/state-machine.ts';

const ctx: OrcContext = {
    originalPrompt: 'Shrink LXC 101 disk from 64GB to 50GB.',
    workingDir: null,
    plan: 'Approved target: shrink LXC 101 Dockge disk from 64GB to 50GB. Never use 8GB.',
    workerResults: [],
    origin: 'test',
};

beforeEach(() => { resetState('default'); });
afterEach(() => { resetState('default'); });

test('buildApprovedPlanPromptBlock returns empty outside active execution states', () => {
    assert.equal(buildApprovedPlanPromptBlock(ctx, 'IDLE'), '');
    assert.equal(buildApprovedPlanPromptBlock(ctx, 'P'), '');
    assert.equal(buildApprovedPlanPromptBlock({ ...ctx, plan: null }, 'B'), '');
});

test('buildApprovedPlanPromptBlock includes numeric and destructive guard language', () => {
    const block = buildApprovedPlanPromptBlock(ctx, 'B');

    assert.ok(block.startsWith('## Approved Plan (authoritative)'));
    assert.ok(block.includes('64GB to 50GB'));
    assert.ok(block.includes('Never use 8GB'));
    assert.ok(block.includes('numeric targets'));
    assert.ok(block.includes('paths'));
    assert.ok(block.includes('resource IDs'));
    assert.ok(block.includes('destructive operation parameters'));
    assert.ok(block.includes('STOP and ask the user'));
});

for (const state of ['A', 'B', 'C'] as OrcStateName[]) {
    test(`orchestrate prepends Approved Plan for Boss ${state} turns`, async () => {
        let capturedPrompt = '';
        setState(state, ctx, 'default');

        await orchestrate('continue', {
            origin: 'test',
            _skipClear: true,
            _skipInsert: true,
            _spawnAgent: (prompt: string) => {
                capturedPrompt = prompt;
                return {
                    child: null,
                    promise: Promise.resolve({ text: 'ok', code: 0 }),
                };
            },
        } as any);

        assert.ok(capturedPrompt.startsWith('## Approved Plan (authoritative)'));
        assert.ok(capturedPrompt.includes(ctx.plan!));
    });
}

test('B state prompt describes Boss and dispatch plan injection', () => {
    const prompt = getStatePrompt('B');

    assert.ok(prompt.includes('injects it into Boss prompts and dispatch tasks'));
    assert.ok(prompt.includes('numeric, path, resource-id, date, limit, or destructive action'));
});
