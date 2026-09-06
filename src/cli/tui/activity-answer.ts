import type { RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import type { TranscriptState, TranscriptItem, TuiAnswerReadTarget } from './transcript.js';
import { wrapActivityTerminalText } from './activity-terminal-text.js';
import { createHash } from 'node:crypto';
import type { ActivityTranscriptItem } from './activity.js';

const answerDigest = (text: string | null): string => createHash('sha256').update(JSON.stringify(text)).digest('hex');
const EMPTY_DIGESTS = new Set([answerDigest(null), answerDigest('')]);

export function tuiAnswerKey(item: TuiAnswerReadTarget): string {
    return item.type === 'activity' ? item.answerKey ?? item.key : item.activityKey!;
}

/** Both live and transactional replay adoption bind the original receipt. */
export function bindActivityAnswerReceipt(state: TranscriptState, item: ActivityTranscriptItem): boolean {
    const identity = item.model.identity;
    const receipts = state.items.filter(row => row.type === 'assistant' && row.activityReadIdentity?.runId === identity.runId);
    if (receipts.length > 1 || receipts.some(row => row.type === 'assistant'
        && (row.activityReadIdentity?.sessionId !== identity.sessionId || row.activityReadIdentity.scope !== identity.scope))) return false;
    const receipt = receipts[0];
    if (receipt?.type === 'assistant' && receipt.activityKey) {
        item.answerKey = receipt.activityKey;
        item.terminalStatus ??= receipt.activityStatus ?? 'finished';
        item.compatibilityDone = true;
        if (receipt.answerReadState) item.answerReadState = receipt.answerReadState;
    }
    return true;
}

function latestAnswer(state: TranscriptState, key: string): Extract<TranscriptItem, { type: 'assistant' }> | undefined {
    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i]!;
        if (item.type === 'assistant' && item.activityKey === key) return item;
    }
    return undefined;
}

export function renderActivityAnswer(item: Extract<TranscriptItem, { type: 'assistant' }>, width: number): string[] {
    const notice = item.answerReadState === 'pending' ? 'Loading saved answer…'
        : item.answerReadState === 'unavailable' ? 'Saved answer unavailable. Open F6 to retry.' : '';
    const notices = notice ? wrapActivityTerminalText(notice, width) : [];
    if (!item.text && !item.activityCorrection) return notices;
    const prefix = width > 2 ? '  ' : '';
    const label = item.activityDiagnostic ? (item.activityCorrection ? 'Updated diagnostic' : 'Diagnostic')
        : item.activityCorrection ? 'Updated answer' : item.activityStatus === undefined || item.activityStatus === 'done' ? 'Answer' : 'Partial answer';
    if (!item.text) return wrapActivityTerminalText(`${label}: ${item.activityFinality === 'absent' ? 'No final answer was returned.' : 'The final answer is empty.'}`, width);
    return [...[label, ...wrapActivityTerminalText(item.text, Math.max(1, width - prefix.length))]
        .flatMap(line => wrapActivityTerminalText(prefix + line, width)), ...notices];
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
    source: 'compatibility' | 'saved',
): boolean {
    const digest = answerDigest(outcome.finalText);
    const finality = outcome.finalText === null ? 'absent' : 'present';
    const existing = latestAnswer(state, key);
    let correction = false;
    let diagnostic = false;
    if (existing?.type === 'assistant') {
        if (outcome.status !== undefined) existing.activityStatus ??= outcome.status;
        // One compatibility terminal per run. Saved MESSAGE alone may refine it.
        // Absence is never authority to erase an already delivered body.
        if (existing.activitySource === 'saved' || source !== 'saved' || outcome.finalText === null) return false;
        existing.activitySource = 'saved';
        if (existing.activityDigest === digest) return false;
        // Emitted bytes cannot be retracted. Label a changed delivery explicitly.
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
