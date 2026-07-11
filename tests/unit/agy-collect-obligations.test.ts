import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcast } from '../../src/core/bus.ts';

test.mock.module('../../src/orchestrator/pipeline.ts', {
    namedExports: {
        isContinueIntent: () => false,
        isResetIntent: () => false,
        orchestrateContinue: () => undefined,
        orchestrateReset: () => undefined,
        orchestrate: (_prompt: string, meta: Record<string, unknown>) => {
            queueMicrotask(() => broadcast('orchestrate_done', meta));
        },
    },
});

test('AGY-OB-005: collect exposes AGY metadata and normal payloads omit it', async () => {
    const { orchestrateAndCollectData } = await import('../../src/orchestrator/collect.ts');
    const agy = await orchestrateAndCollectData('task', {
        text: 'withheld', requestId: 'agy-ob-1', agyPlannerOnly: true, agyCheckpointSeen: true,
    });
    assert.equal(agy.data.agyPlannerOnly, true);
    assert.equal(agy.data.agyCheckpointSeen, true);

    const normal = await orchestrateAndCollectData('task', { text: 'normal', requestId: 'agy-ob-2' });
    assert.equal(normal.text, 'normal');
    assert.equal('agyPlannerOnly' in normal.data, false);
    assert.equal('agyCheckpointSeen' in normal.data, false);
});
