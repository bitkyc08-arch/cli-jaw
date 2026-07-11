import type { TurnSegment, TurnSegmentDetailRef } from '../shared/chat-events.js';
import { db } from './db.js';

type TurnSegmentRow = {
    turn_id: string;
    turn_seq: number;
    type: string;
    status: string;
    trace_run_id: string | null;
    trace_seq: number | null;
};

const insertTurnSegment = db.prepare(`
    INSERT INTO turn_segments (
        turn_id, turn_seq, type, status, trace_run_id, trace_seq
    ) VALUES (?, ?, ?, ?, ?, ?)
`);

const selectTurnSegments = db.prepare(`
    SELECT turn_id, turn_seq, type, status, trace_run_id, trace_seq
    FROM turn_segments
    WHERE turn_id = ?
    ORDER BY turn_seq ASC
`);

function requireNonEmpty(value: string, field: string): void {
    if (!value.trim()) throw new TypeError(`${field} must be a non-empty string`);
}

function validateDetailRef(detailRef: TurnSegmentDetailRef | null): void {
    if (detailRef === null) return;
    requireNonEmpty(detailRef.traceRunId, 'detailRef.traceRunId');
    if (!Number.isSafeInteger(detailRef.traceSeq) || detailRef.traceSeq < 1) {
        throw new TypeError('detailRef.traceSeq must be a positive safe integer');
    }
}

function fromRow(row: TurnSegmentRow): TurnSegment {
    return {
        turnId: row.turn_id,
        turnSeq: row.turn_seq,
        type: row.type,
        status: row.status,
        detailRef: row.trace_run_id !== null && row.trace_seq !== null
            ? { traceRunId: row.trace_run_id, traceSeq: row.trace_seq }
            : null,
    };
}

export function appendTurnSegment(segment: TurnSegment): TurnSegment {
    requireNonEmpty(segment.turnId, 'turnId');
    requireNonEmpty(segment.type, 'type');
    requireNonEmpty(segment.status, 'status');
    if (!Number.isSafeInteger(segment.turnSeq) || segment.turnSeq < 1) {
        throw new TypeError('turnSeq must be a positive safe integer');
    }
    validateDetailRef(segment.detailRef);

    insertTurnSegment.run(
        segment.turnId,
        segment.turnSeq,
        segment.type,
        segment.status,
        segment.detailRef?.traceRunId ?? null,
        segment.detailRef?.traceSeq ?? null,
    );
    return { ...segment, detailRef: segment.detailRef ? { ...segment.detailRef } : null };
}

export function readTurnSegments(turnId: string): TurnSegment[] {
    requireNonEmpty(turnId, 'turnId');
    return (selectTurnSegments.all(turnId) as TurnSegmentRow[]).map(fromRow);
}
