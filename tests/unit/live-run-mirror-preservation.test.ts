// ── Worker-mirror preservation across boss tool syncs (devlog 260620 R1) ──
// Root cause being guarded: worker/employee tool cards vanished on reload under
// claude (dense boss tool stream) but survived under codex (sparse). The boss's
// replaceLiveRunTools(scope, ctx.toolLog) OVERWROTE the live-run scope on every
// boss tool, wiping the isEmployee mirrors that appendLiveRunTool had appended to
// the same scope — so by persist time a dense boss had no mirrors left, while a
// sparse one happened to leave them intact. The fix makes replaceLiveRunTools
// preserve isEmployee entries. This test is the red-green proof.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    beginLiveRun,
    appendLiveRunTool,
    replaceLiveRunTools,
    getLiveRun,
    clearLiveRun,
} from '../../src/agent/live-run-state.js';

const labelsOf = (scope: string): string[] => getLiveRun(scope).toolLog.map((t) => t.label);
const employeeLabels = (scope: string): string[] =>
    getLiveRun(scope).toolLog.filter((t) => t.isEmployee === true).map((t) => t.label);

test('LRM-001: a boss tool sync does not wipe an accumulated worker mirror', () => {
    const scope = 'lrm-boss-1';
    clearLiveRun(scope);
    beginLiveRun(scope, 'claude');

    // worker mirrors land in the boss scope via appendLiveRunTool (spawn.ts appendParentLiveRunTool)
    appendLiveRunTool(scope, { icon: '🔧', label: 'worker-grep', stepRef: 'claude:tooluse:w1', status: 'done', isEmployee: true });

    // boss emits a tool → replaceLiveRunTools(scope, bossToolLog) (spawn.ts:240 et al)
    replaceLiveRunTools(scope, [{ icon: '🔧', label: 'boss-read', stepRef: 'claude:tooluse:b1', status: 'done' }]);

    const labels = labelsOf(scope);
    assert.ok(labels.includes('boss-read'), 'boss tool present');
    assert.ok(labels.includes('worker-grep'), 'worker mirror MUST survive the boss sync (was wiped before the fix)');
    assert.deepEqual(employeeLabels(scope), ['worker-grep'], 'isEmployee flag preserved on the mirror');
    clearLiveRun(scope);
});

test('LRM-002: dense boss (many syncs) still keeps worker mirrors — the claude repro', () => {
    const scope = 'lrm-boss-2';
    clearLiveRun(scope);
    beginLiveRun(scope, 'claude');

    appendLiveRunTool(scope, { icon: '🔧', label: 'worker-A', stepRef: 'claude:tooluse:wa', status: 'done', isEmployee: true });
    // simulate a dense boss: repeated syncs with a growing boss tool log
    const bossTools: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 12; i++) {
        bossTools.push({ icon: '🔧', label: `boss-${i}`, stepRef: `claude:tooluse:b${i}`, status: 'done' });
        replaceLiveRunTools(scope, bossTools.slice());
    }
    appendLiveRunTool(scope, { icon: '🔧', label: 'worker-B', stepRef: 'claude:tooluse:wb', status: 'done', isEmployee: true });
    replaceLiveRunTools(scope, bossTools.slice());

    const emp = employeeLabels(scope);
    assert.ok(emp.includes('worker-A'), 'first worker mirror survives 12 boss syncs');
    assert.ok(emp.includes('worker-B'), 'later worker mirror survives');
    clearLiveRun(scope);
});

test('LRM-003: no false duplication of mirrors across repeated syncs', () => {
    const scope = 'lrm-boss-3';
    clearLiveRun(scope);
    beginLiveRun(scope, 'claude');

    appendLiveRunTool(scope, { icon: '🔧', label: 'worker-once', stepRef: 'claude:tooluse:w1', status: 'done', isEmployee: true });
    for (let i = 0; i < 5; i++) {
        replaceLiveRunTools(scope, [{ icon: '🔧', label: 'boss-x', stepRef: 'claude:tooluse:bx', status: 'done' }]);
    }
    const occurrences = labelsOf(scope).filter((l) => l === 'worker-once').length;
    assert.equal(occurrences, 1, 'mirror preserved exactly once, not duplicated per sync');
    clearLiveRun(scope);
});
