import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { countWorkerProgress, sortWorkerProgress } from '../../public/manager/src/workers/useWorkerProgress.ts';
import { buildWorkerActivityTimeline } from '../../public/manager/src/workers/worker-activity-timeline.ts';
import {
    workerMonitorRowsFixture,
    workerProgressEventFrameFixture,
    workerProgressSnapshotFixture,
    workerRunFixture,
} from '../fixtures/manager-runtime-monitors.ts';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('worker progress helpers sort current workers before previous runs and count attention', () => {
    const rows = [
        workerProgressSnapshotFixture({
            agentId: 'previous',
            previous: workerRunFixture({
                agentId: 'previous',
                employeeName: 'Previous',
                state: 'done',
                taskPreview: 'done',
                startedAt: 1,
                completedAt: 5,
                progressUpdatedAt: 4,
                tools: [],
            }),
        }),
        workerProgressSnapshotFixture({
            agentId: 'running',
            current: workerRunFixture({
                agentId: 'running',
                employeeName: 'Running',
                state: 'running',
                taskPreview: 'run',
                startedAt: 10,
                completedAt: null,
                progressUpdatedAt: 20,
                attention: { kind: 'stalled', message: 'stalled', occurredAt: 20 },
                tools: [],
            }),
        }),
    ];

    assert.deepEqual(sortWorkerProgress(rows).map(row => row.agentId), ['running', 'previous']);
    assert.deepEqual(countWorkerProgress(rows), { running: 1, previous: 1, attention: 1 });
});

test('worker monitor fixtures cover lifecycle attention and replay states deterministically', () => {
    const rows = workerMonitorRowsFixture();
    const attentionKinds = rows.flatMap(row => {
        const run = row.current ?? row.previous;
        return run?.attention ? [run.attention.kind] : [];
    });

    assert.deepEqual(attentionKinds, ['stalled', 'disconnected', 'timeout', 'pending_replay', 'replay_failed']);
    assert.deepEqual(countWorkerProgress(rows), { running: 4, previous: 3, attention: 5 });
    assert.deepEqual(workerProgressEventFrameFixture('timeout'), {
        topic: 'worker',
        event: 'worker_timeout',
        agentId: 'worker_timeout',
        employeeName: 'Worker timeout',
        occurredAt: Date.parse('2026-06-19T00:00:00.000Z') + 2000,
    });
});

test('worker activity timeline separates dispatch, subagent, tool, attention, and result entities', () => {
    const timeline = buildWorkerActivityTimeline({
        agentId: 'runner',
        employeeName: 'Runner',
        state: 'running',
        taskPreview: 'audit worker flow',
        startedAt: 1,
        completedAt: null,
        progressUpdatedAt: 3,
        resultPreview: 'partial result',
        attention: { kind: 'stalled', message: 'No activity', occurredAt: 4 },
        tools: [
            { label: 'Verify', toolType: 'subagent', isEmployee: true, status: 'running', detail: 'checking qa' },
            { label: 'git status', toolType: 'shell', status: 'done', detail: 'clean' },
        ],
    });

    assert.deepEqual(timeline.map(item => item.kind), ['dispatch', 'subagent', 'tool', 'attention', 'result']);
    assert.equal(timeline[0]?.label, 'Runner dispatched');
    assert.equal(timeline[1]?.label, 'Verify');
    assert.equal(timeline[3]?.status, 'attention');
});

test('worker progress client uses Manager orchestrate progress routes and SSE refresh triggers', () => {
    const client = read('public/manager/src/workers/worker-progress-client.ts');
    const hook = read('public/manager/src/workers/useWorkerProgress.ts');

    assert.ok(client.includes('/api/orchestrate/worker-progress'), 'client must list worker progress through Manager API');
    assert.ok(client.includes('/api/orchestrate/worker-progress/${encodeURIComponent(agentId)}'), 'client must support focused worker progress detail');
    assert.ok(client.includes("frame['topic'] === 'worker'"), 'worker lifecycle events must trigger refresh');
    assert.ok(client.includes("frame['topic'] === 'agent' && frame['isEmployee'] === true"), 'employee agent events must trigger refresh');
    assert.ok(client.includes("event === 'agent_tool' || event === 'agent_status' || event === 'agent_done'"), 'tool/status/done events must rehydrate progress');
    assert.ok(client.includes("frame['topic'] === 'system' && frame['event'] === 'replay_gap'"), 'SSE replay gaps must be handled');
    assert.ok(hook.includes('subscribeToWorkerProgressEvents'), 'hook must subscribe to worker progress event stream');
    assert.ok(hook.includes('client.listWorkers()'), 'hook must hydrate from progress API');
});

test('worker progress monitor panel exposes current, previous, attention, and detail states', () => {
    const panel = read('public/manager/src/workers/WorkerProgressMonitorPanel.tsx');
    const css = read('public/manager/src/workers/worker-progress-monitor.css');
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    const cssEntry = read('public/manager/src/code/code.css');

    assert.ok(panel.includes('aria-label="Worker progress monitor"'), 'panel must expose monitor semantics');
    assert.ok(panel.includes('counts.running'), 'panel must show running count');
    assert.ok(panel.includes('counts.previous'), 'panel must show previous count');
    assert.ok(panel.includes('counts.attention'), 'panel must show attention count');
    assert.ok(panel.includes('run.phaseLabel || run.phase'), 'panel must show phase context');
    assert.ok(panel.includes('attention.kind.replaceAll'), 'panel must show lifecycle attention kind');
    assert.ok(panel.includes('buildWorkerActivityTimeline(run).slice(-8)'), 'panel must show bounded activity timeline');
    assert.ok(panel.includes('Activity timeline'), 'panel must label the worker activity timeline');
    assert.ok(css.includes('.code-worker-timeline'), 'monitor must style the worker activity timeline');
    assert.ok(panel.includes('resultPreview'), 'panel must show result preview');
    assert.ok(css.includes('.code-worker-list'), 'monitor must have bounded list styles');
    assert.ok(css.includes('max-height: min(30vh, 300px);'), 'monitor list must not push composer off screen');
    assert.ok(workbench.includes('<WorkerProgressMonitorPanel />'), 'Code workbench must mount the worker monitor');
    assert.ok(cssEntry.includes("@import '../workers/worker-progress-monitor.css';"), 'Code CSS entry must import monitor CSS');
});

test('worker progress monitor remains Manager-local and separate from sessions/background tasks', () => {
    const combined = [
        read('public/manager/src/workers/WorkerProgressMonitorPanel.tsx'),
        read('public/manager/src/workers/useWorkerProgress.ts'),
        read('public/manager/src/workers/worker-progress-client.ts'),
    ].join('\n');

    assert.equal(combined.includes('selectedInstance'), false, 'monitor must not depend on selected child Jaw instance');
    assert.equal(combined.includes('CodeSession'), false, 'monitor must not model workers as Code sessions');
    assert.equal(combined.includes('/api/code'), false, 'monitor must not call Code session APIs');
    assert.equal(combined.includes('/api/bgtask'), false, 'worker monitor must not call background task APIs');
    assert.equal(combined.includes('3465'), false, 'monitor must not hardcode child Jaw ports');
});
