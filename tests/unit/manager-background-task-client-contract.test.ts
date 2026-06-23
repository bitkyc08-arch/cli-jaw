import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    createBackgroundTaskClient,
    normalizeBackgroundTaskUpdate,
    subscribeToBackgroundTaskUpdates,
    type BackgroundTaskEventSourceCtor,
    type BackgroundTaskRow,
} from '../../public/manager/src/background-tasks/background-task-client.ts';
import {
    backgroundTaskFixture,
    backgroundTaskUpdateFixture,
} from '../fixtures/manager-runtime-monitors.ts';

const root = join(import.meta.dirname, '..', '..');

function sampleTask(id = 'bg_test'): BackgroundTaskRow {
    return backgroundTaskFixture({
        id,
        kind: 'shell',
        spec: {
            command: ['node', '-e', 'setTimeout(() => {}, 1000)'],
            completion: { type: 'exit' },
            promptTemplate: 'resume {{taskId}}',
        },
        status: 'running',
        pid: 123,
        createdAt: '2026-06-19T00:00:00.000Z',
        startedAt: '2026-06-19T00:00:01.000Z',
        runnerActive: true,
    });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
    });
}

test('background task client uses Manager-local bgtask routes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        const task = sampleTask('bg_1');
        if (String(url).includes('/api/bgtask/bg_1') && init?.method === 'DELETE') {
            return jsonResponse({ ok: true, cancelled: true, task: { ...task, status: 'cancelled' } });
        }
        if (String(url).includes('/api/bgtask/bg_1')) return jsonResponse({ task });
        if (String(url).endsWith('/api/bgtask')) return jsonResponse({ ok: true, task, warnings: [] });
        return jsonResponse({ tasks: [task] });
    };
    const client = createBackgroundTaskClient({ baseUrl: 'http://127.0.0.1:24576', fetchImpl });

    assert.equal((await client.listTasks({ status: 'running', limit: 25 })).length, 1);
    assert.equal((await client.getTask('bg_1')).id, 'bg_1');
    assert.equal((await client.createTask({
        kind: 'shell',
        spec: {
            command: ['node', '-e', 'console.log("done")'],
            completion: { type: 'exit' },
            promptTemplate: 'done {{result}}',
        },
    })).task.id, 'bg_1');
    assert.equal((await client.createTask({
        preset: 'web-ai',
        sessionId: 'web_ai_session_1',
        prompt: 'deliver {{result}}',
        originMeta: { origin: 'web' },
    })).task.id, 'bg_1');
    assert.equal((await client.cancelTask('bg_1')).cancelled, true);

    assert.deepEqual(calls.map(call => [call.url, call.init?.method ?? 'GET']), [
        ['http://127.0.0.1:24576/api/bgtask?status=running&limit=25', 'GET'],
        ['http://127.0.0.1:24576/api/bgtask/bg_1', 'GET'],
        ['http://127.0.0.1:24576/api/bgtask', 'POST'],
        ['http://127.0.0.1:24576/api/bgtask', 'POST'],
        ['http://127.0.0.1:24576/api/bgtask/bg_1', 'DELETE'],
    ]);
    const webAiCall = calls[3]!;
    assert.deepEqual(JSON.parse(String(webAiCall.init?.body)), {
        preset: 'web-ai',
        sessionId: 'web_ai_session_1',
        prompt: 'deliver {{result}}',
        originMeta: { origin: 'web' },
    });
});

test('background task update normalizer accepts only bgtask_update frames', () => {
    assert.equal(normalizeBackgroundTaskUpdate({ topic: 'jwc', event: 'code_update' }), null);
    assert.equal(normalizeBackgroundTaskUpdate({ topic: 'bgtask', event: 'ping' }), null);

    const update = normalizeBackgroundTaskUpdate({
        ...backgroundTaskUpdateFixture(),
        running: [
            { id: 'bg_1', kind: 'shell', status: 'running', statusCategory: 'running', startedAt: '2026-06-19T00:00:01.000Z' },
            { id: 'bg_invalid_category', kind: 'shell', status: 'running', statusCategory: 'bad' },
            { id: 2, kind: 'bad' },
        ],
        changed: { id: 'bg_2', kind: 'web-ai', status: 'complete', statusCategory: 'succeeded' },
        sseReplay: true,
    });

    assert.deepEqual(update, {
        topic: 'bgtask',
        event: 'bgtask_update',
        running: [
            { id: 'bg_1', kind: 'shell', status: 'running', statusCategory: 'running', startedAt: '2026-06-19T00:00:01.000Z' },
            { id: 'bg_invalid_category', kind: 'shell', status: 'running' },
        ],
        changed: { id: 'bg_2', kind: 'web-ai', status: 'complete', statusCategory: 'succeeded' },
        sseReplay: true,
    });
});

test('background task SSE subscription filters multiplexed /api/events frames', () => {
    class FakeEventSource {
        static instances: FakeEventSource[] = [];
        url: string;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        closed = false;

        constructor(url: string) {
            this.url = url;
            FakeEventSource.instances.push(this);
        }

        close(): void {
            this.closed = true;
        }
    }

    const updates: unknown[] = [];
    let replayGap = 0;
    let errors = 0;
    const sub = subscribeToBackgroundTaskUpdates({
        baseUrl: 'http://127.0.0.1:24576',
        EventSourceImpl: FakeEventSource as BackgroundTaskEventSourceCtor,
        onUpdate: update => updates.push(update),
        onReplayGap: () => { replayGap += 1; },
        onError: () => { errors += 1; },
    });

    assert.equal(FakeEventSource.instances.length, 1);
    const es = FakeEventSource.instances[0]!;
    assert.equal(es.url, 'http://127.0.0.1:24576/api/events');

    es.onmessage?.({ data: '{"topic":"system","event":"ping"}' } as MessageEvent);
    es.onmessage?.({ data: '{"topic":"system","event":"replay_gap"}' } as MessageEvent);
    es.onmessage?.({
        data: JSON.stringify({
            topic: 'bgtask',
            event: 'bgtask_update',
            running: [{ id: 'bg_3', kind: 'shell', status: 'running', statusCategory: 'running' }],
            changed: { id: 'bg_3', kind: 'shell', status: 'running', statusCategory: 'running' },
        }),
    } as MessageEvent);
    es.onerror?.({ type: 'error' } as Event);
    sub.close();

    assert.equal(replayGap, 1);
    assert.equal(errors, 1);
    assert.equal(updates.length, 1);
    assert.equal((updates[0] as { changed: { id: string } }).changed.id, 'bg_3');
    assert.equal(es.closed, true);
});

test('background task monitor contract stays separate from Code sessions and child instances', () => {
    const source = readFileSync(
        join(root, 'public/manager/src/background-tasks/background-task-client.ts'),
        'utf8',
    );
    assert.ok(source.includes('/api/bgtask'), 'client must use Manager /api/bgtask');
    assert.ok(source.includes('/api/events'), 'client must use Manager multiplexed SSE stream');
    assert.ok(source.includes('statusCategory'), 'client must preserve shared runtime status categories');
    assert.equal(source.includes('CodeSession'), false, 'background tasks must not be modeled as Code sessions');
    assert.equal(source.includes('selectedInstance'), false, 'background tasks must not depend on selected child Jaw instance');
    assert.equal(source.includes('3465'), false, 'client must not hardcode child Jaw ports');
});
