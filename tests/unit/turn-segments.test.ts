import test from 'node:test';
import assert from 'node:assert/strict';
import { db, insertMessageWithTraceRun } from '../../src/core/db.ts';
import {
    appendTurnSegment,
    pruneTurnSegments,
    readTurnSegments,
    readTurnSegmentsForTurnIds,
} from '../../src/core/turn-segments.ts';
import type { TurnSegment } from '../../src/shared/chat-events.ts';

const turnId = `turn-segments-${process.pid}-${Date.now()}`;
const createdAt = Date.now();

test('turn segments append/read round-trip preserves order, open types, and trace refs', () => {
    const segments: TurnSegment[] = [
        {
            turnId,
            turnSeq: 2,
            segmentId: 'segment-collab',
            sessionId: 'session-round-trip',
            createdAt,
            observedAt: createdAt + 2,
            providerAt: null,
            fidelity: null,
            thinkingMarker: null,
            type: 'collab',
            status: 'completed_by_worker',
            detailRef: null,
        },
        {
            turnId,
            turnSeq: 1,
            segmentId: 'segment-tool',
            sessionId: 'session-round-trip',
            createdAt,
            observedAt: createdAt + 1,
            providerAt: createdAt,
            fidelity: 'full',
            thinkingMarker: null,
            type: 'tool',
            status: 'done',
            detailRef: { traceRunId: 'tr_1234567890abcdef', traceSeq: 7 },
        },
    ];

    for (const segment of segments) appendTurnSegment(segment);

    assert.deepEqual(readTurnSegments(turnId), [segments[1], segments[0]]);
    db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
});

test('turn segments reject duplicate sequence numbers instead of updating in place', () => {
    const duplicateTurnId = `${turnId}-duplicate`;
    const segment: TurnSegment = {
        turnId: duplicateTurnId,
        turnSeq: 1,
        segmentId: 'segment-duplicate',
        sessionId: 'session-duplicate',
        createdAt,
        observedAt: createdAt,
        providerAt: null,
        fidelity: 'text_only',
        thinkingMarker: null,
        type: 'assistant_text',
        status: 'running',
        detailRef: null,
    };

    appendTurnSegment(segment);
    assert.throws(() => appendTurnSegment({ ...segment, status: 'done' }), /UNIQUE constraint failed/);
    assert.deepEqual(readTurnSegments(duplicateTurnId), [segment]);
    db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(duplicateTurnId);
});

test('turn segment schema includes session and retention columns', () => {
    const columns = db.prepare('PRAGMA table_info(turn_segments)').all() as Array<{ name: string }>;
    const names = new Set(columns.map(column => column.name));
    assert.ok(names.has('session_id'));
    assert.ok(names.has('created_at'));
    assert.ok(names.has('segment_id'));
    assert.ok(names.has('observed_at'));
    assert.ok(names.has('provider_at'));
    assert.ok(names.has('fidelity'));
    assert.ok(names.has('thinking_marker'));

    const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    assert.ok(messageColumns.some(column => column.name === 'turn_id'));
});

test('turn segment batch read groups requested turns in sequence order', () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const firstTurnId = `turn-batch-a-${suffix}`;
    const secondTurnId = `turn-batch-b-${suffix}`;
    const makeSegment = (batchTurnId: string, turnSeq: number): TurnSegment => ({
        turnId: batchTurnId,
        turnSeq,
        segmentId: `${batchTurnId}:${turnSeq}`,
        sessionId: `session-batch-${suffix}`,
        createdAt,
        observedAt: createdAt + turnSeq,
        providerAt: null,
        fidelity: 'full',
        thinkingMarker: null,
        type: turnSeq === 1 ? 'turn_start' : 'assistant_text',
        status: turnSeq === 1 ? 'running' : 'done',
        detailRef: null,
    });
    appendTurnSegment(makeSegment(firstTurnId, 2));
    appendTurnSegment(makeSegment(firstTurnId, 1));
    appendTurnSegment(makeSegment(secondTurnId, 1));

    const grouped = readTurnSegmentsForTurnIds([
        secondTurnId,
        firstTurnId,
        firstTurnId,
        '',
    ]);

    assert.deepEqual(grouped.get(firstTurnId)?.map(segment => segment.turnSeq), [1, 2]);
    assert.deepEqual(grouped.get(secondTurnId)?.map(segment => segment.turnSeq), [1]);
    assert.equal(grouped.size, 2);
    assert.equal(readTurnSegmentsForTurnIds([]).size, 0);
    db.prepare('DELETE FROM turn_segments WHERE turn_id IN (?, ?)').run(firstTurnId, secondTurnId);
});

test('trace-aware message insert persists the turn join key', () => {
    const messageTurnId = `turn-message-link-${process.pid}-${Date.now()}`;
    const content = `turn message link ${messageTurnId}`;
    const info = insertMessageWithTraceRun.run(
        'assistant',
        content,
        'claude',
        null,
        null,
        null,
        null,
        null,
        'default',
        messageTurnId,
    );
    const row = db.prepare('SELECT turn_id FROM messages WHERE id = ?').get(info.lastInsertRowid) as {
        turn_id: string | null;
    };
    assert.equal(row.turn_id, messageTurnId);
    db.prepare('DELETE FROM messages WHERE id = ?').run(info.lastInsertRowid);
});

test('pruneTurnSegments deletes only old orphan segments', () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const old = Date.now() - 8 * 86_400_000;
    const fresh = Date.now();
    const segments: TurnSegment[] = [
        {
            turnId: `turn-orphan-${suffix}`,
            turnSeq: 1,
            segmentId: `segment-orphan-${suffix}`,
            sessionId: `session-orphan-${suffix}`,
            createdAt: old,
            observedAt: old,
            providerAt: null,
            fidelity: 'coarse',
            thinkingMarker: null,
            type: 'turn_start',
            status: 'running',
            detailRef: null,
        },
        {
            turnId: `turn-fresh-${suffix}`,
            turnSeq: 1,
            segmentId: `segment-fresh-${suffix}`,
            sessionId: `session-fresh-${suffix}`,
            createdAt: fresh,
            observedAt: fresh,
            providerAt: null,
            fidelity: 'full',
            thinkingMarker: null,
            type: 'turn_start',
            status: 'running',
            detailRef: null,
        },
        {
            turnId: `turn-session-protected-${suffix}`,
            turnSeq: 1,
            segmentId: `segment-session-protected-${suffix}`,
            sessionId: `session-protected-${suffix}`,
            createdAt: old,
            observedAt: old,
            providerAt: null,
            fidelity: null,
            thinkingMarker: null,
            type: 'assistant_text',
            status: 'done',
            detailRef: null,
        },
        {
            turnId: `turn-trace-protected-${suffix}`,
            turnSeq: 1,
            segmentId: `segment-trace-protected-${suffix}`,
            sessionId: `session-no-message-${suffix}`,
            createdAt: old,
            observedAt: old,
            providerAt: null,
            fidelity: null,
            thinkingMarker: null,
            type: 'tool',
            status: 'done',
            detailRef: { traceRunId: `tr_${suffix.replaceAll('-', '').padEnd(16, '0')}`, traceSeq: 1 },
        },
    ];
    for (const segment of segments) appendTurnSegment(segment);

    db.prepare('INSERT INTO messages (role, content, session_id) VALUES (?, ?, ?)').run(
        'assistant',
        'session retention anchor',
        segments[2]!.sessionId,
    );
    db.prepare('INSERT INTO messages (role, content, session_id, trace_run_id) VALUES (?, ?, ?, ?)').run(
        'assistant',
        'trace retention anchor',
        `other-session-${suffix}`,
        segments[3]!.detailRef!.traceRunId,
    );

    const result = pruneTurnSegments(7);

    assert.equal(result.deletedSegments, 1);
    assert.deepEqual(readTurnSegments(segments[0]!.turnId), []);
    assert.equal(readTurnSegments(segments[1]!.turnId).length, 1);
    assert.equal(readTurnSegments(segments[2]!.turnId).length, 1);
    assert.equal(readTurnSegments(segments[3]!.turnId).length, 1);
    db.prepare('DELETE FROM turn_segments WHERE turn_id IN (?, ?, ?)').run(
        segments[1]!.turnId,
        segments[2]!.turnId,
        segments[3]!.turnId,
    );
    db.prepare('DELETE FROM messages WHERE content IN (?, ?)').run(
        'session retention anchor',
        'trace retention anchor',
    );
});
