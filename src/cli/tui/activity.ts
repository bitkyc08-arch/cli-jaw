import type { RuntimeEvent, RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import type { PresentationMode } from '../../shared/presentation.js';
import { activityKey, activityEntryLabel, activityEntryText, applyActivityEvent, createActivityState,
    type ActivityState } from '../../shared/activity-state.js';
import { wrapActivityTerminalText } from './activity-terminal-text.js';
import type { TranscriptItem } from './transcript.js';

export interface ActivityTranscriptItem {
    type: 'activity';
    key: string;
    model: ActivityState;
    collapsed: boolean;
    timestamp: number;
    revision: number;
    terminalStatus: RuntimeTurnOutcome['status'] | null;
    degraded: boolean;
    recordingGap: boolean;
    released: boolean;
    presentation: PresentationMode;
    compatibilityDone: boolean;
    lineReceipts: Map<string, { chars: number; hash: string; label: string }>;
    lineActiveItemId: string | null;
}

export function createActivityItem(event: RuntimeEvent, verbose = false): ActivityTranscriptItem {
    return { type: 'activity', key: activityKey(event), model: createActivityState(event), collapsed: !verbose,
        timestamp: Date.now(), revision: 0, terminalStatus: null, degraded: false, recordingGap: false, released: false,
        presentation: 'activity', compatibilityDone: false, lineReceipts: new Map(), lineActiveItemId: null };
}

export function updateActivityItem(item: ActivityTranscriptItem, event: RuntimeEvent): boolean {
    if (item.released || !applyActivityEvent(item.model, event)) return false;
    if (event.kind === 'turn-end') {
        item.terminalStatus = event.status;
        item.degraded = item.recordingGap;
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
): string[] {
    const gutter = width > 2 ? '  ' : '';
    const cols = Math.max(1, width - gutter.length);
    const rows: string[] = [];
    const append = (text: string) => rows.push(...wrapActivityTerminalText(text, cols));
    const status = item.terminalStatus === 'done' ? 'Complete' : item.terminalStatus === 'stopped'
        ? 'Stopped' : item.terminalStatus === 'error' ? 'Failed' : 'Working';
    const label = mode === 'activity' ? `${item.collapsed ? '>' : 'v'} Activity: ${status}` : status;
    append(label + (item.model.latestAction ? ` | ${item.model.latestAction}` : ''));
    if (item.degraded) append(item.recordingGap ? 'Activity record incomplete; final answer remains available.'
        : 'Waiting for the Activity record; final answer remains available.');
    if (item.released) append('Preview released; F6 opens retained Activity history.');
    const omitted = item.model.omitted;
    if (omitted.entries || omitted.textChars || omitted.requests) append('Preview limited; F6 opens retained Activity history.');
    for (const request of item.model.requests.values()) {
        append(`Waiting for ${request.requestType}: ${request.title}`);
    }
    if (mode === 'legacy' || !item.collapsed) {
        const entries = [...item.model.entries.values()];
        if (entries.length > PREVIEW_ENTRIES) append(`${entries.length - PREVIEW_ENTRIES} earlier items in F6 history`);
        for (const entry of entries.slice(-PREVIEW_ENTRIES)) {
            append(activityEntryLabel(entry));
            const details = wrapActivityTerminalText(activityEntryText(entry), Math.max(1, cols - 2));
            for (const detail of details.slice(0, PREVIEW_ROWS)) append((cols > 2 ? '  ' : '') + detail);
            if (details.length > PREVIEW_ROWS) append('Detail preview limited; F6 opens history');
        }
    }
    // model.end.finalText is a bounded preview, never the answer body. The
    // authoritative assistant item is appended separately before reduction.
    return rows.map(row => gutter + row);
}
