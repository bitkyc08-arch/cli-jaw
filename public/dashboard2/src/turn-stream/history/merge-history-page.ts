import type {
    MessagesPageResponse,
    SegmentedMessageItem,
} from '../../../../../src/shared/chat-events.ts';
import { rowKey, type RowKey, type TurnStreamAction } from '../types.ts';

export interface HistoryPageOverlap {
    pageRowCount: number;
    uniquePageRowCount: number;
    overlapCount: number;
    hasOverlap: boolean;
}

export function historyPageRowKeys(messages: readonly SegmentedMessageItem[]): RowKey[] {
    return messages.flatMap(message => message.turn_segments.map(segment => rowKey(segment.turnId, segment.turnSeq)));
}

export function diagnoseHistoryPageOverlap(
    page: MessagesPageResponse,
    existingRowKeys: Iterable<RowKey>,
): HistoryPageOverlap {
    const existing = existingRowKeys instanceof Set ? existingRowKeys : new Set(existingRowKeys);
    const keys = historyPageRowKeys(page.data);
    const unique = new Set(keys);
    let overlapCount = 0;
    for (const key of unique) {
        if (existing.has(key)) overlapCount += 1;
    }
    return {
        pageRowCount: keys.length,
        uniquePageRowCount: unique.size,
        overlapCount,
        hasOverlap: overlapCount > 0,
    };
}

export function mergeHistoryPage(page: MessagesPageResponse): TurnStreamAction {
    return { kind: 'history_page', messages: page.data };
}
