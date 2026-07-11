import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTurnSegment, readTurnSegments } from '../../src/core/turn-segments.ts';
import type { TurnSegment } from '../../src/shared/chat-events.ts';

const turnId = `turn-segments-${process.pid}-${Date.now()}`;

test('turn segments append/read round-trip preserves order, open types, and trace refs', () => {
    const segments: TurnSegment[] = [
        {
            turnId,
            turnSeq: 2,
            type: 'collab',
            status: 'completed_by_worker',
            detailRef: null,
        },
        {
            turnId,
            turnSeq: 1,
            type: 'tool',
            status: 'done',
            detailRef: { traceRunId: 'tr_1234567890abcdef', traceSeq: 7 },
        },
    ];

    for (const segment of segments) appendTurnSegment(segment);

    assert.deepEqual(readTurnSegments(turnId), [segments[1], segments[0]]);
});

test('turn segments reject duplicate sequence numbers instead of updating in place', () => {
    const duplicateTurnId = `${turnId}-duplicate`;
    const segment: TurnSegment = {
        turnId: duplicateTurnId,
        turnSeq: 1,
        type: 'assistant_text',
        status: 'running',
        detailRef: null,
    };

    appendTurnSegment(segment);
    assert.throws(() => appendTurnSegment({ ...segment, status: 'done' }), /UNIQUE constraint failed/);
    assert.deepEqual(readTurnSegments(duplicateTurnId), [segment]);
});
