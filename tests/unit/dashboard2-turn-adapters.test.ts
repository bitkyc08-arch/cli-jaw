import assert from 'node:assert/strict';
import test from 'node:test';
import type { TurnSegment } from '../../src/shared/chat-events.ts';
import type { WorkerProgressRun } from '../../src/orchestrator/worker-progress.ts';
import { getDetailController } from '../../public/dashboard2/src/turn-stream/detail/detail-loader.ts';
import { createTurnStore } from '../../public/dashboard2/src/turn-stream/store/turn-store.ts';
import { createWidgetUiStore } from '../../public/dashboard2/src/turn-stream/widgets/widget-ui-store.ts';
import { adaptWidgetSegment } from '../../public/dashboard2/src/turn-stream/widgets/widget-segment-adapter.ts';
import {
    joinCollabSegment,
    joinCollabSegments,
    parseCollabIdentity,
} from '../../public/dashboard2/src/turn-stream/adapters/collab-segment.ts';

function segment(overrides: Partial<TurnSegment> = {}): TurnSegment {
    return {
        turnId: 'turn-1', turnSeq: 1, segmentId: 'segment-1', sessionId: 'session-1',
        createdAt: 1, observedAt: 1, providerAt: null, fidelity: 'full', thinkingMarker: null,
        type: 'tool', status: 'running', detailRef: null, ...overrides,
    };
}

function worker(overrides: Partial<WorkerProgressRun> = {}): WorkerProgressRun {
    return {
        runId: 'run-1', agentId: 'agent-1', employeeName: 'Worker', state: 'running',
        taskPreview: 'task', startedAt: 1, completedAt: null, progressUpdatedAt: 1,
        elapsedMs: 1, tools: [], ...overrides,
    };
}

test('detail controller memoizes per store and ref', () => {
    const store = createTurnStore('detail-adapter');
    const ref = { traceRunId: 'trace', traceSeq: 2 };
    assert.equal(getDetailController(store, ref), getDetailController(store, { ...ref }));
    store.dispose();
});

test('widget UI store owns expansion, placeholder, revision, and width state', () => {
    const store = createWidgetUiStore();
    const panelKey = 'widget:session-1:widget-1';
    const rowKey = 'widget-row:scope-1:turn-1:segment-1';
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.expand(panelKey, rowKey);
    store.setRevision(panelKey, 'rev-2');
    store.setWidthBucket(panelKey, 'wide');
    // Pre-existing red (085 ca69b6df): this used to expect the removed
    // `expanded` mode. The canonical contract is placeholder|inline|panel.
    assert.equal(store.getSnapshot()[panelKey]?.mode, 'inline');
    assert.equal(store.getSnapshot()[panelKey]?.revision, 'rev-2');
    assert.equal(store.getSnapshot()[panelKey]?.widthBucket, 'wide');
    store.collapse(panelKey, rowKey);
    assert.equal(store.getSnapshot()[panelKey]?.mode, 'placeholder');
    unsubscribe();
    assert.equal(notifications, 4);
});

test('widget descriptor merges hydration metadata and safely falls back without durable HTML', () => {
    const row = segment({ type: 'widget', segmentId: 'legacy-widget' });
    const full = adaptWidgetSegment(row, { descriptor: {
        widgetId: 'chart-1', storage: 'file', revision: 'r3', title: 'Revenue',
        estimatedHeight: 320, capabilities: ['interactive', 'stateful', 'invalid'], html: '<script />',
    } });
    assert.deepEqual(full?.descriptor, {
        widgetId: 'chart-1', storage: 'file', revision: 'r3', title: 'Revenue',
        estimatedHeight: 320, capabilities: ['interactive', 'stateful'],
    });
    assert.equal('html' in (full?.descriptor ?? {}), false);
    assert.deepEqual(adaptWidgetSegment(row, { title: '', estimatedHeight: -1 })?.descriptor, {
        widgetId: 'legacy-widget', storage: 'inline', revision: 'legacy', title: 'Widget',
        estimatedHeight: 160, capabilities: [],
    });

    const encoded = Buffer.from(JSON.stringify({
        widgetId: 'encoded', storage: 'file', revision: 'r4', title: 'Encoded',
        estimatedHeight: 240, capabilities: ['interactive'],
    })).toString('base64url');
    assert.equal(adaptWidgetSegment(segment({ type: 'widget', segmentId: `widget:${encoded}` }))?.descriptor.title, 'Encoded');
});

test('collab rows converge by run, preserve restarts, and expose the last terminal verdict', () => {
    const oldSegment = segment({ type: 'collab', segmentId: 'collab:agent-a:run-old' });
    const newSegment = segment({ type: 'collab', turnSeq: 2, segmentId: 'collab:agent-a:run-new' });
    const rows = [
        worker({ runId: 'run-old', agentId: 'agent-a' }),
        worker({ runId: 'run-old', agentId: 'agent-a', state: 'done', resultPreview: 'first verdict' }),
        worker({ runId: 'run-old', agentId: 'agent-a', state: 'done', resultPreview: 'final verdict' }),
        worker({ runId: 'run-new', agentId: 'agent-a' }),
    ];
    const old = joinCollabSegment(oldSegment, rows);
    assert.equal(old?.run?.state, 'done');
    assert.equal(old?.verdict, 'final verdict');
    const items = joinCollabSegments([oldSegment, newSegment], rows);
    assert.deepEqual(items.map(item => item.runId), ['run-old', 'run-new']);
    assert.equal(items[1]?.run?.state, 'running');
});

test('collab identity falls back to detailRef and malformed rows return null', () => {
    assert.deepEqual(parseCollabIdentity(segment({
        type: 'collab', segmentId: 'legacy', detailRef: { traceRunId: 'collab:agent-b:run-b', traceSeq: 1 },
    })), { agentId: 'agent-b', runId: 'run-b' });
    assert.deepEqual(parseCollabIdentity(segment({
        type: 'collab', segmentId: 'collab:agent%3Aencoded:run%2Fencoded',
    })), { agentId: 'agent:encoded', runId: 'run/encoded' });
    assert.equal(parseCollabIdentity(segment({ type: 'collab', segmentId: 'collab:broken' })), null);
});
