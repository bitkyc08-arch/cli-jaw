import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { db } from '../../src/core/db.ts';
import { subscribe } from '../../src/core/event-bus.ts';
import { readTurnSegments } from '../../src/core/turn-segments.ts';
import {
    appendCollabTurnSegment,
    emitAgentTool,
    finishTurnLifecycle,
    getTurnId,
    parseCollabSegmentId,
} from '../../src/agent/events/helpers.ts';
import {
    parseWidgetSegmentId,
    publishWidgetTurnSegment,
} from '../../src/agent/events/widget-turn-segment.ts';
import type { TurnSegment, WidgetTurnSegmentDescriptor } from '../../src/shared/chat-events.ts';
import type { SpawnContext } from '../../src/types/agent.ts';

type ProducerContext = SpawnContext & {
    parentTurnId?: string | null;
    workerRunId?: string | null;
};

function context(overrides: Partial<ProducerContext> = {}): ProducerContext {
    return {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
        runtimeCli: 'claude',
        traceAudience: 'public',
        ...overrides,
    };
}

function capturePublicTurnSegments(): {
    rows: TurnSegment[];
    unsubscribe: () => void;
} {
    const rows: TurnSegment[] = [];
    const unsubscribe = subscribe(entry => {
        if (entry.topic === 'agent' && entry.event === 'turn_segment') {
            rows.push(entry.data as unknown as TurnSegment);
        }
    });
    return { rows, unsubscribe };
}

test('collab producer appends public durable completed, error, and cancelled lifecycles', () => {
    const parent = context({ liveScope: 'producer-parent-statuses' });
    const turnId = getTurnId(parent, 'public');
    const capture = capturePublicTurnSegments();

    try {
        for (const [runId, terminal] of [
            ['run-completed', 'done'],
            ['run-error', 'error'],
            ['run-cancelled', 'cancelled'],
        ] as const) {
            const worker = context({
                traceAudience: 'internal',
                parentLiveScope: 'deliberately-wrong-scope',
                parentTurnId: turnId,
                workerRunId: runId,
                traceRunId: `trace-${runId}`,
            });
            emitAgentTool(worker, 'worker-S', {
                icon: 'tool',
                label: 'Read',
                toolType: 'Read',
                status: 'running',
            }, { isEmployee: true });
            appendCollabTurnSegment(worker, 'worker-S', runId, terminal);
        }

        const durable = readTurnSegments(turnId).filter(segment => segment.type === 'collab');
        assert.deepEqual(durable, capture.rows);
        assert.deepEqual(durable.map(segment => segment.status), [
            'running', 'done',
            'running', 'error',
            'running', 'cancelled',
        ]);
        assert.deepEqual(durable.map(segment => parseCollabSegmentId(segment.segmentId)), [
            { agentId: 'worker-S', runId: 'run-completed' },
            { agentId: 'worker-S', runId: 'run-completed' },
            { agentId: 'worker-S', runId: 'run-error' },
            { agentId: 'worker-S', runId: 'run-error' },
            { agentId: 'worker-S', runId: 'run-cancelled' },
            { agentId: 'worker-S', runId: 'run-cancelled' },
        ]);
        assert.equal(durable.every(segment => !('body' in segment)), true);
    } finally {
        capture.unsubscribe();
        db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
    }
});

test('collab producer keys worker restarts by immutable runId, not display agentId', () => {
    const parent = context({ liveScope: 'producer-parent-restart' });
    const turnId = getTurnId(parent, 'public');
    const capture = capturePublicTurnSegments();

    try {
        const oldRun = context({ parentTurnId: turnId, workerRunId: 'run-old', traceRunId: 'trace-shared' });
        const newRun = context({ parentTurnId: turnId, workerRunId: 'run-new', traceRunId: 'trace-shared' });
        appendCollabTurnSegment(oldRun, 'same-worker', 'run-old', 'done');
        appendCollabTurnSegment(newRun, 'same-worker', 'run-new', 'done');

        const durable = readTurnSegments(turnId).filter(segment => segment.type === 'collab');
        assert.deepEqual(durable, capture.rows);
        assert.equal(new Set(durable.map(segment => segment.segmentId)).size, 2);
        assert.deepEqual(
            [...new Set(durable.map(segment => parseCollabSegmentId(segment.segmentId)?.runId))],
            ['run-old', 'run-new'],
        );
    } finally {
        capture.unsubscribe();
        db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
    }
});

test('collab producer does not fall back to an employee turn when parent lookup fails', () => {
    const worker = context({
        parentTurnId: 'missing-parent-turn',
        parentLiveScope: 'missing-parent-scope',
        workerRunId: 'run-without-parent',
        traceRunId: 'trace-without-parent',
    });
    const capture = capturePublicTurnSegments();

    try {
        assert.deepEqual(
            appendCollabTurnSegment(worker, 'orphan-worker', 'run-without-parent', 'done'),
            [],
        );
        assert.deepEqual(capture.rows, []);
    } finally {
        capture.unsubscribe();
    }
});

test('traceRunId never substitutes for immutable workerRunId', () => {
    const parent = context({ liveScope: 'producer-parent-no-trace-fallback' });
    const turnId = getTurnId(parent, 'public');
    const worker = context({
        parentTurnId: turnId,
        traceAudience: 'internal',
        traceRunId: 'trace-only-not-a-worker-run',
    });
    const capture = capturePublicTurnSegments();

    try {
        emitAgentTool(worker, 'trace-only-worker', {
            icon: 'tool', label: 'Read', toolType: 'Read', status: 'running',
        }, { isEmployee: true });
        assert.deepEqual(readTurnSegments(turnId).filter(segment => segment.type === 'collab'), []);
        assert.deepEqual(capture.rows, []);
    } finally {
        capture.unsubscribe();
        db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
    }
});

test('spawn initialization error branch durably terminalizes the collab run', async () => {
    const { finalizeSpawnInitializationError } = await import('../../src/agent/spawn.ts');
    const parent = context({ liveScope: 'producer-parent-spawn-error' });
    const turnId = getTurnId(parent, 'public');
    const worker = context({
        parentTurnId: turnId,
        workerRunId: 'run-spawn-error',
        traceRunId: 'trace-spawn-error',
    });
    const child = new EventEmitter();
    const capture = capturePublicTurnSegments();

    try {
        child.once('error', () => {
            finalizeSpawnInitializationError(worker, 'failed-worker', true, 'internal', 'standard');
        });
        child.emit('error', new Error('mocked spawn initialization failure'));

        const durable = readTurnSegments(turnId).filter(segment => segment.type === 'collab');
        assert.deepEqual(durable.map(segment => segment.status), ['running', 'error']);
        assert.equal(durable[0]?.segmentId, durable[1]?.segmentId);
        assert.deepEqual(parseCollabSegmentId(durable[1]!.segmentId), {
            agentId: 'failed-worker',
            runId: 'run-spawn-error',
        });
        assert.deepEqual(capture.rows, durable);
    } finally {
        capture.unsubscribe();
        db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
    }
});

test('tool-less detached worker retains a terminal collab row after parent turn_end', async () => {
    const { beginSpawnedWorkerCollab } = await import('../../src/agent/spawn.ts');
    const parent = context({ liveScope: 'producer-parent-detached' });
    const turnId = getTurnId(parent, 'public');
    const worker = context({
        parentTurnId: turnId,
        workerRunId: 'run-detached',
        traceRunId: 'trace-detached',
    });
    const capture = capturePublicTurnSegments();

    try {
        beginSpawnedWorkerCollab(worker, 'detached-worker', true);
        assert.equal(worker.toolLog.length, 0);
        finishTurnLifecycle(parent, 'done', 'public');
        appendCollabTurnSegment(worker, 'detached-worker', 'run-detached', 'cancelled');

        const durable = readTurnSegments(turnId);
        const collab = durable.filter(segment => segment.type === 'collab');
        const turnEnd = durable.find(segment => segment.type === 'turn_end');
        assert.deepEqual(collab.map(segment => segment.status), ['running', 'cancelled']);
        assert.equal(collab[0]?.segmentId, collab[1]?.segmentId);
        assert.ok((collab[1]?.turnSeq ?? 0) > (turnEnd?.turnSeq ?? 0));
        assert.deepEqual(capture.rows.filter(segment => segment.turnId === turnId), collab);
    } finally {
        capture.unsubscribe();
        db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
    }
});

test('worker dispatch propagates registry runId and resolved parent turnId into spawn context', async () => {
    const { readFile } = await import('node:fs/promises');
    const distribute = await readFile(new URL('../../src/orchestrator/distribute.ts', import.meta.url), 'utf8');
    const spawn = await readFile(new URL('../../src/agent/spawn.ts', import.meta.url), 'utf8');
    const lifecycle = await readFile(new URL('../../src/agent/lifecycle-handler.ts', import.meta.url), 'utf8');

    assert.match(distribute, /const workerSlot = getWorkerSlot\(empId\)/);
    assert.match(distribute, /const workerRunId = workerSlot\?\.runId/);
    assert.match(distribute, /parentLiveScope = text\(workerSlot\?\.replayMeta\?\.scopeId\)/);
    assert.match(distribute, /workerRunId \? \{ workerRunId \} : \{\}/);
    assert.match(spawn, /opts\.parentLiveScope \|\| liveScope/);
    assert.match(spawn, /parentTurnIdForChild[\s\S]*getPublicTurnIdForLiveScope\(parentLiveScopeForChild\)/);
    assert.match(spawn, /parentTurnId:\s*parentTurnIdForChild/);
    assert.match(spawn, /workerRunId:\s*opts\.workerRunId/);
    assert.match(lifecycle, /turnStatus !== 'continued' && isEmployee/);
    assert.match(lifecycle, /wasKilled \? 'cancelled'/);
});

test('widget producer preserves stored and live revision descriptors without durable HTML body', () => {
    const parent = context({ liveScope: 'producer-parent-widget' });
    const turnId = getTurnId(parent, 'public');
    const capture = capturePublicTurnSegments();
    const stored: WidgetTurnSegmentDescriptor = {
        widgetId: 'diagram-sales',
        storage: 'file',
        revision: 'rev-1',
        title: 'Sales by region',
        estimatedHeight: 320,
        capabilities: ['interactive'],
    };
    const liveRevision: WidgetTurnSegmentDescriptor = {
        ...stored,
        revision: 'rev-2',
        capabilities: ['interactive', 'stateful'],
    };

    try {
        publishWidgetTurnSegment(parent, stored, 'done');
        publishWidgetTurnSegment(parent, liveRevision, 'running');

        const durable = readTurnSegments(turnId).filter(segment => segment.type === 'widget');
        assert.deepEqual(durable, capture.rows);
        assert.deepEqual(durable.map(segment => parseWidgetSegmentId(segment.segmentId)), [stored, liveRevision]);
        assert.deepEqual(durable.map(segment => segment.status), ['done', 'running']);
        assert.equal(durable.every(segment => segment.detailRef === null), true);
        assert.equal(durable.every(segment => !('body' in segment) && !('html' in segment)), true);
    } finally {
        capture.unsubscribe();
        db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
    }
});

test('widget producer stays explicit until the 06x parser has an owning turn context', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
        new URL('../../src/agent/events/widget-turn-segment.ts', import.meta.url),
        'utf8',
    );
    assert.match(source, /current widget watcher only has chatId\/widgetId/);
    assert.match(source, /06x dashboard2 widget migration/);
    assert.match(source, /parent SpawnContext and revision/);
});
