import type { TurnSegment } from '../../../../../src/shared/chat-events.ts';

export interface PreparedFoldSnapshot {
    placeholderHeight: number;
    shouldCollapseWidget: boolean;
    foldKey: string;
}

export interface FoldFramePresence {
    turnId: string;
    liveCount: number;
    committedCount: number;
}

export interface FoldFrameReconciliation {
    duplicateCount: number;
    missingCount: number;
    maxVisibleCount: number;
    isAtomic: boolean;
}

function estimatedRowHeight(row: TurnSegment, widgetExpanded: boolean): number {
    switch (row.type) {
        case 'turn_start':
        case 'turn_end': return 0;
        case 'tool': return 32;
        case 'collab': return 40;
        case 'widget': return widgetExpanded ? 320 : 72;
        case 'assistant_text':
        case 'thinking': return 48;
        default: return 40;
    }
}

export function prepareFoldSnapshot(
    liveModel: { turnId: string; rows: TurnSegment[] },
    widgetExpanded: boolean,
): PreparedFoldSnapshot {
    const rowHeight = liveModel.rows.reduce(
        (height, row) => height + estimatedRowHeight(row, widgetExpanded),
        0,
    );
    const durableRows = liveModel.rows
        .map(row => `${row.turnSeq}:${row.segmentId}`)
        .join('|');
    return {
        placeholderHeight: Math.max(48, rowHeight),
        shouldCollapseWidget: widgetExpanded,
        foldKey: `${liveModel.turnId}::${durableRows}`,
    };
}

/**
 * Trace-only UI policy. TurnStore owns the atomic liveTurns -> T0/T1 transaction;
 * this helper neither mutates nor mirrors that store state.
 */
export function reconcileFoldFrame(
    previous: FoldFramePresence,
    next: FoldFramePresence,
): FoldFrameReconciliation {
    if (previous.turnId !== next.turnId) {
        throw new Error('fold frame turnId mismatch');
    }
    const totals = [
        previous.liveCount + previous.committedCount,
        next.liveCount + next.committedCount,
    ];
    const duplicateCount = totals.reduce((count, total) => count + Math.max(0, total - 1), 0);
    const missingCount = totals.filter(total => total === 0).length;
    const maxVisibleCount = Math.max(...totals);
    return {
        duplicateCount,
        missingCount,
        maxVisibleCount,
        isAtomic: duplicateCount === 0 && missingCount === 0 && maxVisibleCount <= 1,
    };
}
