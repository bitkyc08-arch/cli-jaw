import type { RuntimeEvent, RuntimeEventIdentity, RuntimeItemStatus } from './runtime-contract.js';

export const ACTIVITY_MAX_ENTRIES = 128;
export const ACTIVITY_ENTRY_CHARS = 4096;
export const ACTIVITY_TEXT_CHARS = 65536; // UTF-16 units; final and notices have separate budgets.
export const ACTIVITY_MAX_REQUESTS = 16; // Notices only; the live registry owns requests.
export const ACTIVITY_FINAL_CHARS = 32768;

export type ActivityEntry = Extract<RuntimeEvent, { kind: 'message' | 'reasoning' | 'tool' }>;
type RequestNotice = { requestId: string; requestType: 'approval' | 'question'; title: string };

export interface ActivityState {
    identity: Pick<RuntimeEventIdentity, 'runId' | 'sessionId' | 'scope' | 'turnId'>;
    seq: number;
    revision: number;
    entries: Map<string, ActivityEntry>;
    requests: Map<string, RequestNotice>;
    end: Extract<RuntimeEvent, { kind: 'turn-end' }> | null;
    usage: Extract<RuntimeEvent, { kind: 'usage' }> | null;
    latestAction: string;
    omitted: { entries: number; textChars: number; requests: number; finalChars: number; throughSeq: number };
}

export function activityKey(id: ActivityState['identity']): string {
    return JSON.stringify([id.sessionId, id.scope, id.runId, id.turnId]);
}

export function createActivityState(identity: ActivityState['identity']): ActivityState {
    return {
        identity: { runId: identity.runId, sessionId: identity.sessionId, scope: identity.scope, turnId: identity.turnId },
        seq: 0, revision: 0, entries: new Map(), requests: new Map(), end: null, usage: null,
        latestAction: '', omitted: { entries: 0, textChars: 0, requests: 0, finalChars: 0, throughSeq: 0 },
    };
}

const add = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);

export function activityEntryText(entry: ActivityEntry): string {
    return entry.kind === 'tool'
        ? [entry.input, entry.output, entry.detail].filter(v => v !== undefined && v !== '').join('\n')
        : entry.text;
}

function textSize(entry: ActivityEntry): number {
    return entry.kind === 'tool' ? entry.name.length + (entry.input?.length ?? 0)
        + (entry.output?.length ?? 0) + (entry.detail?.length ?? 0) : entry.text.length;
}

export function activityRetainedChars(state: ActivityState): number {
    let size = 0;
    for (const entry of state.entries.values()) size += textSize(entry);
    return size;
}

function boundTool(state: ActivityState, entry: Extract<ActivityEntry, { kind: 'tool' }>): ActivityEntry {
    const bounded = { ...entry };
    // Short fields consume only what they need; divide the remainder fairly among
    // longer fields. A huge input must leave room for both live output and detail.
    const fields = (['name', 'input', 'output', 'detail'] as const)
        .filter(key => entry[key] !== undefined)
        .sort((a, b) => entry[a]!.length - entry[b]!.length);
    let budget = ACTIVITY_ENTRY_CHARS;
    for (let i = 0; i < fields.length; i++) {
        const key = fields[i]!;
        const value = entry[key]!;
        const length = Math.min(value.length, Math.floor(budget / (fields.length - i)));
        bounded[key] = value.slice(0, length);
        budget -= length;
        state.omitted.textChars = add(state.omitted.textChars, value.length - length);
    }
    return bounded;
}

function retain(state: ActivityState, entry: ActivityEntry): void {
    const bounded = entry.kind === 'tool' ? boundTool(state, entry) : { ...entry, text: entry.text.slice(0, ACTIVITY_ENTRY_CHARS) };
    if (entry.kind !== 'tool') {
        state.omitted.textChars = add(state.omitted.textChars, Math.max(0, entry.text.length - ACTIVITY_ENTRY_CHARS));
    }
    state.entries.set(entry.itemId, bounded);
    // Evict preview data only. Journal retention and disclosure choices have other owners.
    while (state.entries.size > ACTIVITY_MAX_ENTRIES || activityRetainedChars(state) > ACTIVITY_TEXT_CHARS) {
        const first = state.entries.entries().next().value;
        if (!first) break;
        state.entries.delete(first[0]);
        state.omitted.entries = add(state.omitted.entries, 1);
        state.omitted.throughSeq = Math.max(state.omitted.throughSeq, first[1].seq);
    }
}

/** Reduces validated events into owned preview state without changing caller events.
 * Sparse committed seq is normal; the journal, not this reducer, reports gaps.
 */
export function applyActivityEvent(state: ActivityState, event: RuntimeEvent): boolean {
    if (activityKey(state.identity) !== activityKey(event) || event.seq <= state.seq || state.end) return false;
    switch (event.kind) {
        case 'turn-start': break;
        case 'message':
        case 'reasoning': {
            const old = state.entries.get(event.itemId);
            if (old && old.kind !== event.kind) throw new Error('runtime_item_kind_changed');
            const prior = event.operation === 'append' && old ? old.text : '';
            // Slice before concatenating. A full prefix never resumes after omitted text;
            // a replacement is a new snapshot and can reclaim the whole entry budget.
            const room = Math.max(0, ACTIVITY_ENTRY_CHARS - prior.length);
            const text = prior + event.text.slice(0, room);
            state.omitted.textChars = add(state.omitted.textChars, Math.max(0, event.text.length - room));
            if (!old && event.operation === 'append' && state.omitted.entries) {
                state.omitted.throughSeq = Math.max(state.omitted.throughSeq, event.seq);
            }
            retain(state, { ...event, text, operation: 'replace' });
            break;
        }
        case 'tool': {
            const old = state.entries.get(event.itemId);
            if (old && old.kind !== 'tool') throw new Error('runtime_item_kind_changed');
            retain(state, { ...old, ...event });
            state.latestAction = (event.name + ' (' + event.status + ')')
                .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').slice(0, 240);
            break;
        }
        case 'request':
            if (state.requests.has(event.requestId) || state.requests.size < ACTIVITY_MAX_REQUESTS) {
                state.requests.set(event.requestId, {
                    requestId: event.requestId, requestType: event.requestType, title: event.view.title.slice(0, 256),
                });
            } else state.omitted.requests = add(state.omitted.requests, 1);
            break;
        case 'request-settled': state.requests.delete(event.requestId); break;
        case 'usage': state.usage = { ...state.usage, ...event }; break;
        case 'turn-end':
            // This is only a preview. The caller keeps the full authoritative answer;
            // null (absent) and empty (an authoritative empty answer) remain distinct.
            state.omitted.finalChars = Math.max(0, (event.finalText?.length ?? 0) - ACTIVITY_FINAL_CHARS);
            state.end = {
                ...event, finalText: event.finalText === null ? null : event.finalText.slice(0, ACTIVITY_FINAL_CHARS),
                ...(event.error === undefined ? {} : { error: event.error.slice(0, 500) }),
            };
            state.requests.clear();
            break;
        default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
    state.seq = event.seq;
    state.revision = add(state.revision, 1);
    return true;
}

export function activityStatus(state: ActivityState): RuntimeItemStatus {
    return state.end?.status ?? 'running';
}

export function activityEntryLabel(entry: ActivityEntry): string {
    if (entry.kind === 'tool') return entry.name + ' (' + entry.status + ')';
    if (entry.kind === 'reasoning') return 'Reasoning';
    return entry.phase === 'commentary' ? 'Commentary' : entry.phase === 'final' ? 'Answer draft' : 'Output (phase unknown)';
}
