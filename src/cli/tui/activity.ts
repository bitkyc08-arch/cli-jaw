import type { RuntimeEvent, RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import type { PresentationMode } from '../../shared/presentation.js';
import { activityKey, activityEntryLabel, activityEntryText, applyActivityEvent, createActivityState,
    type ActivityState } from '../../shared/activity-state.js';
import { wrapActivityTerminalText } from './activity-terminal-text.js';
import type { TranscriptItem, TuiAnswerReadReceipt } from './transcript.js';

export interface ActivityTranscriptItem extends TuiAnswerReadReceipt {
    type: 'activity';
    key: string;
    answerKey?: string;
    model: ActivityState;
    collapsed: boolean;
    timestamp: number;
    revision: number;
    terminalStatus: RuntimeTurnOutcome['status'] | 'finished' | null;
    degraded: boolean;
    recordingGap: boolean;
    displayGap: boolean;
    released: boolean;
    presentation: PresentationMode;
    compatibilityDone: boolean;
    lineReceipts: Map<string, { chars: number; hash: string; label: string }>;
    lineActiveItemId: string | null;
    retired: boolean;
    lineLimitReported: boolean;
}

export function createActivityItem(event: RuntimeEvent, verbose = false): ActivityTranscriptItem {
    const item = createActivityFromState(createActivityState(event), verbose);
    item.timestamp = Date.now();
    return item;
}

export function createActivityFromState(model: ActivityState, verbose = false): ActivityTranscriptItem {
    return { type: 'activity', key: activityKey(model.identity), model, collapsed: !verbose,
        timestamp: 0, revision: 0, terminalStatus: model.end?.status ?? null, degraded: false, recordingGap: false, displayGap: false, released: false,
        presentation: 'activity', compatibilityDone: false, lineReceipts: new Map(), lineActiveItemId: null, retired: false, lineLimitReported: false };
}

export function updateActivityItem(item: ActivityTranscriptItem, event: RuntimeEvent): boolean {
    if (item.released || !applyActivityEvent(item.model, event)) return false;
    if (event.kind === 'turn-end') {
        item.terminalStatus = event.status;
        item.degraded = item.recordingGap || item.displayGap;
    }
    item.revision++;
    return true;
}

export function toggleActivityItem(item: ActivityTranscriptItem): void {
    item.collapsed = !item.collapsed;
    item.revision++;
}

export function toggleLatestActivity(items: TranscriptItem[], start: number): boolean {
    for (let i = items.length - 1; i >= start; i--) {
        const item = items[i];
        if (item?.type === 'activity' && item.presentation === 'activity') {
            toggleActivityItem(item);
            return true;
        }
    }
    return false;
}

/** Release display copies in-place; stable transcript indices and receipts survive. */
export function releaseActivityPreview(item: ActivityTranscriptItem): void {
    if (item.released) return;
    item.model.entries.clear();
    item.model.requests.clear();
    item.model.end = null;
    item.model.usage = null;
    item.lineReceipts.clear();
    item.lineActiveItemId = null;
    item.released = true;
    item.revision++;
}

const PREVIEW_ENTRIES = 40;
const PREVIEW_ROWS = 12;

export function renderActivityItem(
    item: ActivityTranscriptItem, width: number, mode: PresentationMode = item.presentation,
    historyHint = 'F6 opens retained Activity history.',
): string[] {
    const gutter = width > 2 ? '  ' : '';
    const cols = Math.max(1, width - gutter.length);
    const rows: string[] = [];
    const append = (text: string) => rows.push(...wrapActivityTerminalText(text, cols));
    const status = item.retired && !item.terminalStatus ? 'Conversation changed' : item.terminalStatus === 'done' ? 'Complete' : item.terminalStatus === 'stopped'
        ? 'Stopped' : item.terminalStatus === 'error' ? 'Failed' : item.terminalStatus === 'finished' ? 'Finished' : 'Working';
    const label = mode === 'activity' ? `${item.collapsed ? '>' : 'v'} Activity: ${status}` : status;
    append(label + (item.model.latestAction ? ` | ${item.model.latestAction}` : ''));
    if (item.degraded) append(item.recordingGap ? 'Activity record incomplete.'
        : item.displayGap ? `Activity display incomplete. ${historyHint}` : 'Waiting for the Activity record.');
    if (item.released) append(`Preview released. ${historyHint}`);
    if (item.answerReadState === 'pending') append('Loading saved answer…');
    if (item.answerReadState === 'unavailable') append('Saved answer unavailable. Open F6 to retry.');
    const omitted = item.model.omitted;
    if (omitted.entries || omitted.textChars || omitted.requests) append(`Preview limited. ${historyHint}`);
    for (const request of item.terminalStatus || item.retired ? [] : item.model.requests.values()) {
        append(`Waiting for ${request.requestType}: ${request.title}`);
    }
    if (mode === 'legacy' || !item.collapsed) {
        const entries = [...item.model.entries.values()];
        if (entries.length > PREVIEW_ENTRIES) append(`${entries.length - PREVIEW_ENTRIES} earlier items. ${historyHint}`);
        for (const entry of entries.slice(-PREVIEW_ENTRIES)) {
            append(activityEntryLabel(entry));
            const details = wrapActivityTerminalText(activityEntryText(entry), Math.max(1, cols - 2));
            for (const detail of details.slice(0, PREVIEW_ROWS)) append((cols > 2 ? '  ' : '') + detail);
            if (details.length > PREVIEW_ROWS) append(`Detail preview limited. ${historyHint}`);
        }
    }
    // Journal text is redacted: only compatibility delivery or saved MESSAGE
    // may create the separate answer row. Limit the complete display, not entries.
    if (rows.length > 40) rows.splice(39, rows.length - 39, ...wrapActivityTerminalText('More in F6 history.', cols).slice(0, 1));
    return rows.map(row => gutter + row);
}
