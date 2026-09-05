import type { RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import type { TranscriptState, TranscriptItem } from './transcript.js';
import { wrapActivityTerminalText } from './activity-terminal-text.js';
import { createHash } from 'node:crypto';

const answerDigest = (text: string | null): string => createHash('sha256').update(JSON.stringify(text)).digest('hex');
const EMPTY_DIGESTS = new Set([answerDigest(null), answerDigest('')]);

function latestAnswer(state: TranscriptState, key: string): Extract<TranscriptItem, { type: 'assistant' }> | undefined {
    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i]!;
        if (item.type === 'assistant' && item.activityKey === key) return item;
    }
    return undefined;
}

export function renderActivityAnswer(item: Extract<TranscriptItem, { type: 'assistant' }>, width: number): string[] {
    if (!item.text && !item.activityCorrection) return [];
    const prefix = width > 2 ? '  ' : '';
    const label = item.activityDiagnostic ? (item.activityCorrection ? 'Updated diagnostic' : 'Diagnostic')
        : item.activityCorrection ? 'Updated answer' : item.activityStatus === undefined || item.activityStatus === 'done' ? 'Answer' : 'Partial answer';
    if (!item.text) return wrapActivityTerminalText(`${label}: ${item.activityFinality === 'absent' ? 'No final answer was returned.' : 'The final answer is empty.'}`, width);
    return [label, ...wrapActivityTerminalText(item.text, Math.max(1, width - prefix.length))]
        .flatMap(line => wrapActivityTerminalText(prefix + line, width));
}

/** Storage admission is not stdout delivery: a failed preview fold can occur in
 * between. Keep the line-mode delivery receipt on the same authoritative row. */
export function writeActivityAnswer(state: TranscriptState, key: string, width: number, write: (text: string) => unknown): boolean {
    const item = latestAnswer(state, key);
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
    outcome: Pick<RuntimeTurnOutcome, 'finalText'> & { status?: RuntimeTurnOutcome['status'] },
    source: 'canonical' | 'print' = 'canonical',
): boolean {
    const digest = answerDigest(outcome.finalText);
    const finality = outcome.finalText === null ? 'absent' : 'present';
    const existing = latestAnswer(state, key);
    let correction = false;
    let diagnostic = false;
    if (existing?.type === 'assistant') {
        // Print compatibility owns its selected answer (or startup diagnostic).
        // A later canonical terminal supplies status, never a second body; null
        // must not erase that diagnostic or repopulate a released answer.
        if (outcome.status !== undefined) existing.activityStatus ??= outcome.status;
        if (source === 'canonical' && outcome.finalText === null && existing.activitySource === 'print') existing.activityDiagnostic = true;
        if (source !== 'print' || existing.activitySource === 'print') return false;
        diagnostic = existing.activityFinality === 'absent';
        existing.activitySource = 'print';
        if (existing.activityDigest === digest) return false;
        // Canonical records can be redacted. Prefer the original print completion.
        // An emitted line or committed scrollback cannot be retracted: label a
        // differing delivery explicitly, while an uncommitted row changes in place.
        correction = Boolean((existing.activityPrinted || existing.activityReleased)
            && existing.activityDigest && !EMPTY_DIGESTS.has(existing.activityDigest));
        if (!existing.activityReleased) {
            existing.text = outcome.finalText ?? '';
            existing.activityFinality = finality;
            existing.activityDigest = digest;
            existing.activityPrinted = false;
            existing.activityCorrection = correction;
            existing.activityDiagnostic = diagnostic;
            return true;
        }
    }
    // Even a null/empty final leaves a small, invisible receipt in the existing
    // transcript, so replay does not need a parallel final-text buffer or Map.
    const status = outcome.status ?? existing?.activityStatus;
    state.items.push({ type: 'assistant', text: outcome.finalText ?? '', streaming: false,
        timestamp: Date.now(), activityKey: key, ...(status === undefined ? {} : { activityStatus: status }),
        activityFinality: finality, activitySource: source, activityDigest: digest, activityCorrection: correction, activityDiagnostic: diagnostic });
    return true;
}
