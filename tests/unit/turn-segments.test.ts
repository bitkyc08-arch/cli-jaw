import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { appendTurnSegment, pruneTurnSegments, readTurnSegments } from '../../src/core/turn-segments.ts';
import type { TurnSegment } from '../../src/shared/chat-events.ts';

const turnId = `turn-segments-${process.pid}-${Date.now()}`;
const createdAt = Date.now();

test('turn segments append/read round-trip preserves order, open types, and trace refs', () => {
    const segments: TurnSegment[] = [
        {
            turnId,
            turnSeq: 2,
            sessionId: 'session-round-trip',
            createdAt,
            type: 'collab',
            status: 'completed_by_worker',
            detailRef: null,
        },
        {
            turnId,
            turnSeq: 1,
            sessionId: 'session-round-trip',
            createdAt,
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
        sessionId: 'session-duplicate',
        createdAt,
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
});

test('pruneTurnSegments deletes only old orphan segments', () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const old = Date.now() - 8 * 86_400_000;
    const fresh = Date.now();
    const segments: TurnSegment[] = [
        {
            turnId: `turn-orphan-${suffix}`,
            turnSeq: 1,
            sessionId: `session-orphan-${suffix}`,
            createdAt: old,
            type: 'turn_start',
            status: 'running',
            detailRef: null,
        },
        {
            turnId: `turn-fresh-${suffix}`,
            turnSeq: 1,
            sessionId: `session-fresh-${suffix}`,
            createdAt: fresh,
            type: 'turn_start',
            status: 'running',
            detailRef: null,
        },
        {
            turnId: `turn-session-protected-${suffix}`,
            turnSeq: 1,
            sessionId: `session-protected-${suffix}`,
            createdAt: old,
            type: 'assistant_text',
            status: 'done',
            detailRef: null,
        },
        {
            turnId: `turn-trace-protected-${suffix}`,
            turnSeq: 1,
            sessionId: `session-no-message-${suffix}`,
            createdAt: old,
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
