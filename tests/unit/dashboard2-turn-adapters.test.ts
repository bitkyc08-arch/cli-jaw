import assert from 'node:assert/strict';
import test from 'node:test';
import type { TurnSegment } from '../../src/shared/chat-events.ts';
import type { WorkerProgressRun } from '../../src/orchestrator/worker-progress.ts';
import {
    DETAIL_UNAVAILABLE,
    createDetailLoader,
} from '../../public/dashboard2/src/turn-stream/detail/detail-loader.ts';
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

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('detail loader single-flights a key and commits through the fetch token', async () => {
    const request = deferred<unknown>();
    let fetches = 0;
    const puts: Array<[string, unknown]> = [];
    const loader = createDetailLoader(() => { fetches++; return request.promise; }, {
        beginFetch: () => 7,
        resolveFetch: (_token, apply) => { apply(); return true; },
        putDetail: (key, detail) => puts.push([key, detail]),
    });
    const ref = { traceRunId: 'trace', traceSeq: 2 };
    const first = loader.load(ref);
    const second = loader.load(ref);
    assert.equal(first, second);
    request.resolve({ text: 'detail' });
    assert.equal((await first).status, 'ready');
    assert.equal(fetches, 1);
    assert.deepEqual(puts, [['trace#2', { text: 'detail' }]]);
});

test('detail loader caches 404 as unavailable and does not retry', async () => {
    let fetches = 0;
    const puts: unknown[] = [];
    const loader = createDetailLoader(async () => { fetches++; throw { status: 404 }; }, {
        beginFetch: () => 1,
        resolveFetch: (_token, apply) => { apply(); return true; },
        putDetail: (_key, detail) => puts.push(detail),
    });
    const ref = { traceRunId: 'missing', traceSeq: 9 };
    assert.deepEqual(await loader.load(ref), DETAIL_UNAVAILABLE);
    assert.deepEqual(await loader.load(ref), DETAIL_UNAVAILABLE);
    assert.equal(fetches, 1);
    assert.deepEqual(puts, [DETAIL_UNAVAILABLE]);
});

test('detail loader abort leaves store unchanged', async () => {
    let signal: AbortSignal | null = null;
    const puts: unknown[] = [];
    const loader = createDetailLoader((_ref, nextSignal) => {
        signal = nextSignal;
        return new Promise((_resolve, reject) => nextSignal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError'))));
    }, {
        beginFetch: () => 1,
        resolveFetch: (_token, apply) => { apply(); return true; },
        putDetail: (_key, detail) => puts.push(detail),
    });
    const ref = { traceRunId: 'abort', traceSeq: 1 };
    const pending = loader.load(ref);
    loader.abort(ref);
    assert.equal((await pending).status, 'aborted');
    assert.equal(signal?.aborted, true);
    assert.deepEqual(puts, []);
});

test('detail loader drops stale scope results', async () => {
    const puts: unknown[] = [];
    const loader = createDetailLoader(async () => 'late', {
        beginFetch: () => 3,
        resolveFetch: () => false,
        putDetail: (_key, detail) => puts.push(detail),
    });
    assert.equal((await loader.load({ traceRunId: 'stale', traceSeq: 1 })).status, 'stale');
    assert.deepEqual(puts, []);
});

test('widget UI store owns expansion, placeholder, revision, and width state', () => {
    const store = createWidgetUiStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.expand('widget-1');
    store.setRevision('widget-1', 'rev-2');
    store.setWidthBucket('widget-1', 'wide');
    assert.deepEqual(store.getSnapshot()['widget-1'], { mode: 'expanded', revision: 'rev-2', widthBucket: 'wide' });
    store.collapse('widget-1');
    assert.equal(store.getSnapshot()['widget-1']?.mode, 'placeholder');
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
