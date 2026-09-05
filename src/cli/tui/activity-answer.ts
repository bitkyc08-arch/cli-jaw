import type { RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import type { TranscriptState, TranscriptItem } from './transcript.js';
import { wrapActivityTerminalText } from './activity-terminal-text.js';

export function renderActivityAnswer(item: Extract<TranscriptItem, { type: 'assistant' }>, width: number): string[] {
    if (!item.text) return [];
    const prefix = width > 2 ? '  ' : '';
    const label = item.activityStatus === 'done' ? 'Answer' : 'Partial answer';
    return [label, ...wrapActivityTerminalText(item.text, Math.max(1, width - prefix.length))]
        .flatMap(line => wrapActivityTerminalText(prefix + line, width));
}

/** Storage admission is not stdout delivery: a failed preview fold can occur in
 * between. Keep the line-mode delivery receipt on the same authoritative row. */
export function writeActivityAnswer(state: TranscriptState, key: string, width: number, write: (text: string) => unknown): boolean {
    const item = state.items.find(item => item.type === 'assistant' && item.activityKey === key);
    if (item?.type !== 'assistant' || item.activityPrinted) return false;
    const rows = renderActivityAnswer(item, width);
    if (rows.length) write(rows.join('\n') + '\n');
    item.activityPrinted = true;
    return true;
}

/** Full authoritative answer owner. The Activity reducer retains only a preview. */
export function appendActivityAnswer(
    state: TranscriptState,
    key: string,
    outcome: Pick<RuntimeTurnOutcome, 'status' | 'finalText'>,
): boolean {
    if (state.items.some(item => item.type === 'assistant' && item.activityKey === key)) return false;
    // Even a null/empty final leaves a small, invisible receipt in the existing
    // transcript, so replay does not need a parallel final-text buffer or Map.
    state.items.push({ type: 'assistant', text: outcome.finalText ?? '', streaming: false,
        timestamp: Date.now(), activityKey: key, activityStatus: outcome.status,
        activityFinality: outcome.finalText === null ? 'absent' : 'present' });
    return true;
}
