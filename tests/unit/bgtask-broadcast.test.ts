// bgtask_update broadcast — registry transitions emit SSE-bound events with
// running[] snapshot + changed task; topic maps to 'bgtask'.

import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

import { addBroadcastListener, removeBroadcastListener, inferTopic } from '../../src/core/bus.ts';
import { createTask, markTerminal, markCancelled, markOrphaned, markNotified } from '../../src/bgtask/registry.ts';
import type { BgTaskSpec } from '../../src/bgtask/types.ts';

interface Captured { type: string; data: Record<string, unknown> }

let captured: Captured[] = [];
const listener = (type: string, data: Record<string, unknown>) => {
    if (type === 'bgtask_update') captured.push({ type, data });
};

beforeEach(() => {
    captured = [];
    addBroadcastListener(listener);
});
afterEach(() => {
    removeBroadcastListener(listener);
});

let seq = 0;
function spec(): BgTaskSpec {
    seq += 1;
    return {
        command: ['node', '-e', `// bc ${seq} ${Date.now()}`],
        completion: { type: 'exit' },
        promptTemplate: 'p {{result}}',
    };
}

test('inferTopic maps bgtask_update to bgtask topic', () => {
    assert.equal(inferTopic('bgtask_update'), 'bgtask');
});

test('createTask emits bgtask_update with the new task in running[] and changed', () => {
    const row = createTask({ kind: 'shell', spec: spec() });
    assert.equal(captured.length, 1);
    const data = captured[0]!.data;
    const running = data['running'] as Array<{ id: string; kind: string }>;
    assert.ok(running.some((r) => r.id === row.id));
    assert.deepEqual(data['changed'], { id: row.id, kind: 'shell', status: 'running' });
});

test('markTerminal emits once with terminal status; repeated transition emits nothing', () => {
    const row = createTask({ kind: 'shell', spec: spec() });
    captured = [];
    assert.equal(markTerminal(row.id, 'complete', null), true);
    assert.equal(captured.length, 1);
    const data = captured[0]!.data;
    assert.deepEqual(data['changed'], { id: row.id, kind: 'shell', status: 'complete' });
    const running = data['running'] as Array<{ id: string }>;
    assert.ok(!running.some((r) => r.id === row.id), 'terminal task left running[]');

    captured = [];
    assert.equal(markTerminal(row.id, 'failed', null), false);
    assert.equal(captured.length, 0, 'no-op transition must not emit');
});

test('markCancelled, markOrphaned, and markNotified emit monitor updates', () => {
    const a = createTask({ kind: 'shell', spec: spec() });
    captured = [];
    markCancelled(a.id);
    assert.equal(captured.length, 1);
    assert.equal((captured[0]!.data['changed'] as { status: string }).status, 'cancelled');

    const b = createTask({ kind: 'shell', spec: spec() });
    captured = [];
    markOrphaned(b.id);
    assert.equal(captured.length, 1);
    assert.equal((captured[0]!.data['changed'] as { status: string }).status, 'orphaned');

    const c = createTask({ kind: 'shell', spec: spec() });
    markTerminal(c.id, 'complete', null);
    captured = [];
    markNotified(c.id);
    assert.equal(captured.length, 1, 'markNotified must refresh notifiedAt in monitors');
    assert.equal((captured[0]!.data['changed'] as { status: string }).status, 'complete');
});
