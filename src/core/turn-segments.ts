import type { ThinkingMarker, TurnFidelity, TurnSegment, TurnSegmentDetailRef } from '../shared/chat-events.js';
import { db } from './db.js';

type TurnSegmentRow = {
    turn_id: string;
    turn_seq: number;
    segment_id: string;
    session_id: string;
    created_at: number;
    observed_at: number;
    provider_at: number | null;
    fidelity: TurnFidelity | null;
    thinking_marker: ThinkingMarker | null;
    type: string;
    status: string;
    trace_run_id: string | null;
    trace_seq: number | null;
};

const insertTurnSegment = db.prepare(`
    INSERT INTO turn_segments (
        turn_id, turn_seq, segment_id, session_id, created_at,
        observed_at, provider_at, fidelity, thinking_marker,
        type, status, trace_run_id, trace_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectTurnSegments = db.prepare(`
    SELECT turn_id, turn_seq, segment_id, session_id, created_at,
           observed_at, provider_at, fidelity, thinking_marker,
           type, status, trace_run_id, trace_seq
    FROM turn_segments
    WHERE turn_id = ?
    ORDER BY turn_seq ASC
`);

const selectTurnSegmentsForTurnIds = db.prepare(`
    SELECT turn_id, turn_seq, segment_id, session_id, created_at,
           observed_at, provider_at, fidelity, thinking_marker,
           type, status, trace_run_id, trace_seq
    FROM turn_segments
    WHERE turn_id IN (SELECT value FROM json_each(?))
    ORDER BY turn_id ASC, turn_seq ASC
`);

const pruneOrphanTurnSegments = db.prepare(`
    DELETE FROM turn_segments AS segment
    WHERE segment.created_at < ?
      AND NOT EXISTS (
          SELECT 1
          FROM messages AS message
          WHERE message.session_id = segment.session_id
             OR (
                 segment.trace_run_id IS NOT NULL
                 AND message.trace_run_id = segment.trace_run_id
             )
      )
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
        segmentId: row.segment_id,
        sessionId: row.session_id,
        createdAt: row.created_at,
        observedAt: row.observed_at,
        providerAt: row.provider_at,
        fidelity: row.fidelity,
        thinkingMarker: row.thinking_marker,
        type: row.type,
        status: row.status,
        detailRef: row.trace_run_id !== null && row.trace_seq !== null
            ? { traceRunId: row.trace_run_id, traceSeq: row.trace_seq }
            : null,
    };
}

export function appendTurnSegment(segment: TurnSegment): TurnSegment {
    requireNonEmpty(segment.turnId, 'turnId');
    requireNonEmpty(segment.segmentId, 'segmentId');
    requireNonEmpty(segment.sessionId, 'sessionId');
    requireNonEmpty(segment.type, 'type');
    requireNonEmpty(segment.status, 'status');
    if (!Number.isSafeInteger(segment.turnSeq) || segment.turnSeq < 1) {
        throw new TypeError('turnSeq must be a positive safe integer');
    }
    if (!Number.isSafeInteger(segment.createdAt) || segment.createdAt < 0) {
        throw new TypeError('createdAt must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(segment.observedAt) || segment.observedAt < 0) {
        throw new TypeError('observedAt must be a non-negative safe integer');
    }
    if (segment.providerAt !== null && (!Number.isSafeInteger(segment.providerAt) || segment.providerAt < 0)) {
        throw new TypeError('providerAt must be null or a non-negative safe integer');
    }
    validateDetailRef(segment.detailRef);

    insertTurnSegment.run(
        segment.turnId,
        segment.turnSeq,
        segment.segmentId,
        segment.sessionId,
        segment.createdAt,
        segment.observedAt,
        segment.providerAt,
        segment.fidelity,
        segment.thinkingMarker,
        segment.type,
        segment.status,
        segment.detailRef?.traceRunId ?? null,
        segment.detailRef?.traceSeq ?? null,
    );
    return { ...segment, detailRef: segment.detailRef ? { ...segment.detailRef } : null };
}

export function pruneTurnSegments(retentionDays = 7): { deletedSegments: number } {
    const safeDays = Number.isFinite(retentionDays) ? Math.max(0, retentionDays) : 7;
    const cutoff = Date.now() - safeDays * 86_400_000;
    try {
        return { deletedSegments: pruneOrphanTurnSegments.run(cutoff).changes };
    } catch (error) {
        console.error('[turn-segment] prune failed:', error instanceof Error ? error.message : String(error));
        return { deletedSegments: 0 };
    }
}

export function readTurnSegments(turnId: string): TurnSegment[] {
    requireNonEmpty(turnId, 'turnId');
    return (selectTurnSegments.all(turnId) as TurnSegmentRow[]).map(fromRow);
}

export function readTurnSegmentsForTurnIds(turnIds: readonly string[]): Map<string, TurnSegment[]> {
    const ids = [...new Set(turnIds.map(id => id.trim()).filter(Boolean))];
    if (!ids.length) return new Map();
    const result = new Map<string, TurnSegment[]>();
    const rows = selectTurnSegmentsForTurnIds.all(JSON.stringify(ids)) as TurnSegmentRow[];
    for (const row of rows) {
        const segments = result.get(row.turn_id) ?? [];
        segments.push(fromRow(row));
        result.set(row.turn_id, segments);
    }
    return result;
}
