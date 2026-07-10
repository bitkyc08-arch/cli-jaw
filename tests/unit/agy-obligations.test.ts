import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnContext } from '../../src/types/agent.ts';
import { AGY_PLANNER_ONLY_NOTICE, finalizeAgyFallbackText } from '../../src/agent/agy-runtime.ts';
import { updateFinalPlannerFlag } from '../../src/agent/agy-transcript-watcher.ts';
import { consumePendingReminder, evaluateRecordPending } from '../../src/core/policy-flags.ts';

function context(): SpawnContext {
    return {
        fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false, sessionId: null, cost: null, turns: null,
        duration: null, tokens: null, stderrBuf: '', metadata: {},
    };
}

function row(type: string, content: string, createdAt: string, toolCalls?: unknown[]): string {
    return JSON.stringify({ type, content, created_at: createdAt, ...(toolCalls ? { tool_calls: toolCalls } : {}) });
}

test('AGY-OB-001: intermediate planner then checkpoint is planner-only and never delivered', () => {
    const ctx = context();
    const start = Date.parse('2026-07-11T00:00:00.000Z');
    // Synthesized issue shape: no captured my_tool_call_analysis AGY row exists in-repo.
    updateFinalPlannerFlag(ctx, row('USER_INPUT', 'task', '2026-07-11T00:00:05.000Z'), start);
    updateFinalPlannerFlag(ctx, row('PLANNER_RESPONSE', 'my_tool_call_analysis: inspect', '2026-07-11T00:00:06.000Z', []), start);
    updateFinalPlannerFlag(ctx, row('CHECKPOINT', '{{ CHECKPOINT 1 }}', '2026-07-11T00:00:07.000Z'), start);

    assert.equal(ctx.agyFinalPlannerSeen, false);
    assert.equal(ctx.metadata?.['agyCheckpointSeen'], true);
    assert.equal(ctx.metadata?.['agyPlannerOnly'], true);
    ctx.fullText = 'my_tool_call_analysis: inspect';
    assert.equal(finalizeAgyFallbackText(ctx, ctx.fullText), true);
    assert.equal(ctx.fullText, AGY_PLANNER_ONLY_NOTICE);
});

test('AGY-OB-002: checkpoint disarms stale final and a fresh later final re-arms', () => {
    const ctx = context();
    const start = Date.parse('2026-07-11T00:00:00.000Z');
    updateFinalPlannerFlag(ctx, row('PLANNER_RESPONSE', 'stale final', '2026-07-11T00:00:05.000Z'), start);
    assert.equal(ctx.agyFinalPlannerSeen, true);
    updateFinalPlannerFlag(ctx, row('CHECKPOINT', '{{ CHECKPOINT 1 }}', '2026-07-11T00:00:06.000Z'), start);
    assert.equal(ctx.agyFinalPlannerSeen, false);
    updateFinalPlannerFlag(ctx, row('PLANNER_RESPONSE', 'fresh final', '2026-07-11T00:00:07.000Z'), start);
    assert.equal(ctx.agyFinalPlannerSeen, true);
    assert.equal(ctx.agyFinalPlannerText, 'fresh final');
    assert.equal(ctx.metadata?.['agyCheckpointSeen'], true);
    assert.equal(ctx.metadata?.['agyPlannerOnly'], false);
});

test('AGY-OB-003: checkpoint tool evidence activates record_pending', () => {
    const jawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-agy-obligation-'));
    fs.writeFileSync(path.join(jawHome, 'policy-hooks.json'), JSON.stringify({
        flags: { recordPending: { enabled: true, toolPatterns: ['write-state'], reminder: 'Record it.' } },
    }));
    const ctx = context();
    updateFinalPlannerFlag(ctx, row('CHECKPOINT', '{{ CHECKPOINT 1 }}', '2026-07-11T00:00:07.000Z'), 0);
    ctx.toolLog.push({ icon: 'x', label: 'write', toolType: 'tool', command: 'write-state --phase wp2' });
    evaluateRecordPending(ctx.toolLog, AGY_PLANNER_ONLY_NOTICE, { jawHome });
    const state = JSON.parse(fs.readFileSync(path.join(jawHome, 'policy-flags.json'), 'utf8')) as {
        flags: { record_pending: { set: boolean; evidence: string } };
    };
    assert.equal(ctx.metadata?.['agyCheckpointSeen'], true);
    assert.equal(state.flags.record_pending.set, true);
    assert.match(state.flags.record_pending.evidence, /write-state/);
    assert.equal(consumePendingReminder({ jawHome }), '[POLICY FLAG] record_pending\nRecord it.');
});

test('AGY-OB-004: orchestration payload conditionally constructs AGY metadata', () => {
    const pipeline = fs.readFileSync(path.resolve('src/orchestrator/pipeline.ts'), 'utf8');
    assert.match(pipeline, /typeof result\['agyPlannerOnly'\] === 'boolean'/);
    assert.match(pipeline, /typeof result\['agyCheckpointSeen'\] === 'boolean'/);
});
