import type { RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import type { ActivityTranscriptItem } from './activity.js';

export type TuiAnswerReadState = 'pending' | 'saved' | 'absent' | 'unavailable';
export interface TuiAnswerReadIdentity { sessionId: string; scope: string; runId: string; }
export interface TuiAnswerReadReceipt {
    answerReadState?: TuiAnswerReadState;
    answerReadMessage?: string;
}
export type TuiAnswerReadTarget = ActivityTranscriptItem | (Extract<TranscriptItem, { type: 'assistant' }>
    & { activityReadIdentity: TuiAnswerReadIdentity });

interface ActivityPreviewReceipt {
    activityPreviewKey?: string;
    activityPreviewPrinted?: boolean;
    activityPreviewSettled?: boolean;
    activityPreviewTruncated?: boolean;
}

const FALLBACK_PREVIEW_MAX_ROWS = 16;
const FALLBACK_PREVIEW_MAX_CHARS = 32 * 1024;
const FALLBACK_PREVIEW_ROW_CHARS = 4096;

export type TranscriptItem =
    | ActivityTranscriptItem
    | { type: 'user'; displayText: string; submitText: string; timestamp: number; agentId?: string }
    | ({ type: 'assistant'; text: string; streaming: boolean; timestamp: number; agentId?: string;
        activityKey?: string; activityFinality?: 'present' | 'absent'; activityStatus?: RuntimeTurnOutcome['status']; activityPrinted?: boolean;
        activitySource?: 'compatibility' | 'saved'; activityDigest?: string; activityReleased?: boolean; activityCorrection?: boolean; activityDiagnostic?: boolean;
        activityReadIdentity?: TuiAnswerReadIdentity } & ActivityPreviewReceipt & TuiAnswerReadReceipt)
    | ({ type: 'thinking'; text: string; streaming: boolean; timestamp: number; agentId?: string; collapsed?: boolean; stepRef?: string } & ActivityPreviewReceipt)
    | { type: 'tool'; text: string; timestamp: number; agentId?: string; collapsed?: boolean; detail?: string; stepRef?: string; status?: 'running' | 'done' | 'error' }
    | { type: 'command'; text: string; timestamp: number; commandName?: string; ok?: boolean; activityDiagnosticKey?: string }
    | { type: 'status'; text: string; ephemeral: true; timestamp: number; agentId?: string };

export interface TranscriptState {
    items: TranscriptItem[];
    liveTools: LiveToolItem[];
    liveToolsExpanded: boolean;
    committedToolRefs: Set<string>;
    /** 260703 CJ-WP3 — per-turn dedup for stepRef-LESS tool commits (key =
     *  `fallback:agentId:label`). agent-done replays the whole toolLog, and a
     *  stepRef-less tool already committed live was re-appended (the live
     *  entry that used to absorb the key was consumed). Cleared per user turn:
     *  the same label must commit fresh next turn. */
    committedFallbackKeys: Set<string>;
}

export interface LiveToolItem {
    key: string;
    icon: string;
    label: string;
    detail: string;
    status: 'running';
    timestamp: number;
    updatedAt: number;
    agentId?: string;
    stepRef?: string;
}

export interface ToolEventInput {
    icon: string;
    label: string;
    detail: string;
    status: 'running' | 'done' | 'error';
    agentId?: string | undefined;
    stepRef?: string | undefined;
    toolType?: string | undefined;
}

export function createTranscriptState(): TranscriptState {
    return { items: [], liveTools: [], liveToolsExpanded: false, committedToolRefs: new Set(), committedFallbackKeys: new Set() };
}

export function appendUserItem(state: TranscriptState, displayText: string, submitText: string): void {
    // New user turn — stepRef-less fallback keys are turn-scoped (the same
    // tool label must commit fresh rows in later turns).
    state.committedFallbackKeys.clear();
    state.items.push({ type: 'user', displayText, submitText, timestamp: Date.now() });
}

export function startAssistantItem(state: TranscriptState, agentId?: string): void {
    const item: TranscriptItem = { type: 'assistant', text: '', streaming: true, timestamp: Date.now() };
    if (agentId) item.agentId = agentId;
    state.items.push(item);
}

/** Session-scoped verbose render mode: every tool/thinking block renders
 *  permanently expanded — no
 *  minimize when the next tool starts, and the fold toggles become
 *  commit-mode-only. Runtime override set at launch (--verbose), not
 *  persisted. */
let verboseRenderMode = false;

export function setVerboseRenderMode(on: boolean): void {
    verboseRenderMode = on;
}

export function isVerboseRenderMode(): boolean {
    return verboseRenderMode;
}

/** Collapsed state a block settles into when its run completes. */
function settledCollapsed(): boolean {
    return !verboseRenderMode;
}

export function appendToActiveAssistant(state: TranscriptState, chunk: string): boolean {
    const last = state.items[state.items.length - 1];
    if (!last || last.type !== 'assistant' || !last.streaming) return false;
    last.text += chunk;
    return true;
}

export function appendAssistantTurnText(state: TranscriptState, chunk: string, agentId?: string): boolean {
    if (!chunk) return false;
    settleThinkingForAnswer(state, agentId);
    if (appendToActiveAssistant(state, chunk)) return true;
    startAssistantItem(state, agentId);
    return appendToActiveAssistant(state, chunk);
}

/** A missing canonical record permits a preview, never ownership of another run's tail. */
export function appendActivityFallbackPreview(
    state: TranscriptState, key: string, text: string,
    options: { thinking?: boolean; replace?: boolean; agentId?: string; stepRef?: string } = {},
): { item?: Extract<TranscriptItem, { type: 'assistant' | 'thinking' }>; previousText: string; omitted: boolean } | undefined {
    if (!text) return;
    const type = options.thinking ? 'thinking' : 'assistant';
    const previews = state.items.filter((item): item is Extract<TranscriptItem, { type: 'assistant' | 'thinking' }> =>
        (item.type === 'assistant' || item.type === 'thinking') && item.activityPreviewKey === key);
    if (previews.some(item => item.activityPreviewSettled)) return;
    // Once any input is omitted, freeze this run's preview. Resuming at a later
    // chunk could expose the suffix of a discarded OSC/CSI control sequence.
    if (previews.some(item => item.activityPreviewTruncated)) return { previousText: '', omitted: true };
    const existing = previews.find(item => item.type === type && item.agentId === options.agentId
        && (item.type !== 'thinking' || item.stepRef === options.stepRef));
    if (!existing && previews.length >= FALLBACK_PREVIEW_MAX_ROWS) {
        previews[0]!.activityPreviewTruncated = true;
        return { previousText: '', omitted: true };
    }
    const previousText = existing?.text ?? '';
    const budget = Math.min(FALLBACK_PREVIEW_ROW_CHARS,
        FALLBACK_PREVIEW_MAX_CHARS - previews.reduce((sum, item) => sum + item.text.length, 0) + previousText.length);
    const omitted = (options.replace ? text.length : previousText.length + text.length) > budget;
    const bounded = options.replace ? text.slice(0, budget) : previousText + text.slice(0, Math.max(0, budget - previousText.length));
    const item: Extract<TranscriptItem, { type: 'assistant' | 'thinking' }> = existing ?? {
        type, text: bounded, streaming: true, timestamp: Date.now(), activityPreviewKey: key,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.stepRef ? { stepRef: options.stepRef } : {}),
    };
    item.text = bounded;
    item.streaming = true;
    if (!existing) state.items.push(item);
    if (omitted) item.activityPreviewTruncated = true;
    return { item, previousText, omitted };
}

/** Empty tombstones preserve both row references and native scrollback indices. */
export function settleActivityFallbackPreviews(state: TranscriptState, key: string): boolean {
    let printed = false;
    for (const item of state.items) {
        if ((item.type !== 'assistant' && item.type !== 'thinking') || item.activityPreviewKey !== key
            || item.activityPreviewSettled) continue;
        printed ||= Boolean(item.activityPreviewPrinted);
        Object.assign(item, { type: 'assistant', text: '', streaming: false, activityPreviewSettled: true });
    }
    return printed;
}

// A live thinking tail settles into its collapsed
// summary the moment the stream moves past it — i.e. when answer text starts.
// stepRef-driven thinking rows have their own tool-event lifecycle and are
// finalized by commitThinkingItemOnce instead.
export function settleThinkingForAnswer(state: TranscriptState, agentId?: string): boolean {
    let changed = false;
    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i]!;
        if (item.type === 'user') break;
        if (item.type !== 'thinking' || !item.streaming || item.stepRef) continue;
        if (agentId && item.agentId && item.agentId !== agentId) continue;
        item.streaming = false;
        changed = true;
    }
    return changed;
}

function canAppendToThinking(item: TranscriptItem | undefined, agentId?: string): item is Extract<TranscriptItem, { type: 'thinking' }> {
    if (!item || item.type !== 'thinking' || !item.streaming || item.stepRef) return false;
    return !agentId || !item.agentId || item.agentId === agentId;
}

function findActiveThinkingIndex(state: TranscriptState, agentId?: string): number {
    const lastIndex = state.items.length - 1;
    const last = state.items[lastIndex];
    if (canAppendToThinking(last, agentId)) return lastIndex;
    if (last?.type === 'assistant' && canAppendToThinking(state.items[lastIndex - 1], agentId)) return lastIndex - 1;
    return -1;
}

function insertThinkingItem(state: TranscriptState, item: Extract<TranscriptItem, { type: 'thinking' }>): void {
    const tail = state.items[state.items.length - 1];
    if (tail?.type === 'assistant') {
        state.items.splice(state.items.length - 1, 0, item);
    } else {
        state.items.push(item);
    }
}

export function appendThinkingItem(state: TranscriptState, text: string, opts?: { agentId?: string; stepRef?: string; streaming?: boolean; collapsed?: boolean }): boolean {
    if (!text) return false;
    if (opts?.stepRef) {
        const existing = state.items.find((item) => item.type === 'thinking' && item.stepRef === opts.stepRef);
        if (existing?.type === 'thinking') {
            existing.text = text;
            existing.timestamp = Date.now();
            if (typeof opts.streaming === 'boolean') existing.streaming = opts.streaming;
            if (typeof opts.collapsed === 'boolean') existing.collapsed = opts.collapsed;
            if (opts.agentId) existing.agentId = opts.agentId;
            return true;
        }
    }
    const item: Extract<TranscriptItem, { type: 'thinking' }> = {
        type: 'thinking',
        text,
        streaming: opts?.streaming ?? false,
        timestamp: Date.now(),
        collapsed: opts?.collapsed ?? settledCollapsed(),
    };
    if (opts?.agentId) item.agentId = opts.agentId;
    if (opts?.stepRef) item.stepRef = opts.stepRef;
    insertThinkingItem(state, item);
    return true;
}

export function appendThinkingTurnText(state: TranscriptState, chunk: string, agentId?: string): boolean {
    if (!chunk) return false;
    const activeIndex = findActiveThinkingIndex(state, agentId);
    if (activeIndex >= 0) {
        const item = state.items[activeIndex]!;
        if (item.type === 'thinking') {
            item.text += chunk;
            item.timestamp = Date.now();
            return true;
        }
    }
    return appendThinkingItem(state, chunk, { ...(agentId ? { agentId } : {}), streaming: true, collapsed: settledCollapsed() });
}

export function finalizeAssistant(state: TranscriptState, fallbackText?: string): boolean {
    const last = state.items[state.items.length - 1];
    if (!last || last.type !== 'assistant') return false;
    if (last.streaming) {
        last.streaming = false;
    } else if (fallbackText) {
        // agent_done with text but no prior chunks
        last.text = fallbackText;
        last.streaming = false;
    }
    return true;
}

/** Native terminal text is authoritative, including an explicitly empty final.
 * Only the current provisional assistant rows are replaceable; settled work notes,
 * tools, thinking and previous user turns retain their existing history/identity. */
export function replaceNativeAssistantFinal(state: TranscriptState, text: string, agentId?: string): void {
    let boundary = -1;
    for (let i = state.items.length - 1; i >= 0; i--) {
        if (state.items[i]?.type === 'user') { boundary = i; break; }
    }
    state.items = state.items.filter((item, index) =>
        index <= boundary || item.type !== 'assistant' || !item.streaming);
    if (text.length > 0) state.items.push({
        type: 'assistant', text, streaming: false, timestamp: Date.now(),
        ...(agentId ? { agentId } : {}),
    });
}

export function finalizeStreamingAssistants(state: TranscriptState): boolean {
    let changed = false;
    for (const item of state.items) {
        if ((item.type === 'assistant' || item.type === 'thinking') && item.streaming) {
            item.streaming = false;
            changed = true;
        }
    }
    return changed;
}

export function hasAssistantTextSinceLastUser(state: TranscriptState): boolean {
    return assistantTextSinceLastUser(state).trim().length > 0;
}

export function assistantTextSinceLastUser(state: TranscriptState): string {
    const chunks: string[] = [];
    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i]!;
        if (item.type === 'user') break;
        if (item.type === 'assistant' && item.text.length > 0) chunks.unshift(item.text);
    }
    return chunks.join('');
}

// A tool event interrupts the
// answer segment — the streaming assistant tail settles (loses its cursor)
// and any answer text after the tools starts a new assistant item.
export function settleAssistantForTool(state: TranscriptState, agentId?: string): boolean {
    const last = state.items[state.items.length - 1];
    if (!last || last.type !== 'assistant' || !last.streaming) return false;
    if (agentId && last.agentId && last.agentId !== agentId) return false;
    last.streaming = false;
    return true;
}

export function appendToolItem(state: TranscriptState, text: string, opts?: { agentId?: string; detail?: string; stepRef?: string; status?: 'running' | 'done' | 'error' }): void {
    settleAssistantForTool(state, opts?.agentId);
    if (opts?.stepRef) {
        const existing = state.items.find((item) => item.type === 'tool' && item.stepRef === opts.stepRef);
        if (existing?.type === 'tool') {
            existing.text = opts.detail ? text : existing.text;
            existing.timestamp = Date.now();
            if (opts.status) {
                existing.status = opts.status;
                existing.collapsed = settledCollapsed() && opts.status !== 'running';
            }
            if (opts.agentId) existing.agentId = opts.agentId;
            if (opts.detail) existing.detail = opts.detail;
            return;
        }
    }
    collapsePreviousTools(state);
    const item: TranscriptItem = {
        type: 'tool',
        text,
        timestamp: Date.now(),
        collapsed: settledCollapsed() && (opts?.status ? opts.status !== 'running' : false),
    };
    if (opts?.agentId) item.agentId = opts.agentId;
    if (opts?.detail) item.detail = opts.detail;
    if (opts?.stepRef) item.stepRef = opts.stepRef;
    if (opts?.status) item.status = opts.status;
    state.items.push(item);
}

export function makeToolEventKey(input: { label: string; agentId?: string | undefined; stepRef?: string | undefined }): string {
    if (input.stepRef) return `ref:${input.stepRef}`;
    return `fallback:${input.agentId ?? 'main'}:${input.label}`;
}

export function isThinkingToolEvent(input: { toolType?: string | undefined }): boolean {
    return input.toolType?.toLowerCase() === 'thinking';
}

function thinkingTextFromToolInput(input: ToolEventInput): string {
    return input.detail || input.label;
}

export function commitThinkingItemOnce(state: TranscriptState, input: ToolEventInput, commitOpts?: { updateCommitted?: boolean }): boolean {
    if (input.stepRef && state.committedToolRefs.has(input.stepRef)) {
        if (commitOpts?.updateCommitted && thinkingTextFromToolInput(input)) {
            appendThinkingItem(state, thinkingTextFromToolInput(input), {
                ...(input.agentId ? { agentId: input.agentId } : {}),
                stepRef: input.stepRef,
                streaming: false,
                collapsed: settledCollapsed(),
            });
        }
        return false;
    }
    if (input.stepRef) state.committedToolRefs.add(input.stepRef);
    return appendThinkingItem(state, thinkingTextFromToolInput(input), {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.stepRef ? { stepRef: input.stepRef } : {}),
        streaming: false,
        collapsed: settledCollapsed(),
    });
}

export function upsertLiveToolItem(state: TranscriptState, input: ToolEventInput): LiveToolItem {
    settleAssistantForTool(state, input.agentId);
    const key = makeToolEventKey(input);
    const now = Date.now();
    const existing = state.liveTools.find(item => item.key === key);
    if (existing) {
        existing.icon = input.icon;
        existing.label = input.label;
        existing.detail = input.detail || existing.detail;
        existing.updatedAt = now;
        if (input.agentId) existing.agentId = input.agentId;
        if (input.stepRef) existing.stepRef = input.stepRef;
        return existing;
    }
    const item: LiveToolItem = {
        key,
        icon: input.icon,
        label: input.label,
        detail: input.detail,
        status: 'running',
        timestamp: now,
        updatedAt: now,
    };
    if (input.agentId) item.agentId = input.agentId;
    if (input.stepRef) item.stepRef = input.stepRef;
    state.liveTools.push(item);
    return item;
}

export function commitToolItemOnce(state: TranscriptState, input: ToolEventInput, commitOpts?: { updateCommitted?: boolean }): boolean {
    const key = makeToolEventKey(input);
    const liveIndex = state.liveTools.findIndex(item => item.key === key);
    const live = liveIndex >= 0 ? state.liveTools[liveIndex] : null;
    if (liveIndex >= 0) state.liveTools.splice(liveIndex, 1);
    if (!input.stepRef && state.committedFallbackKeys.has(key)) {
        // Already committed this turn (agent-done toolLog replay): update the
        // last matching stepRef-less row in place — mirroring the stepRef
        // update path and the live-lane upsert that merges the same key.
        if (commitOpts?.updateCommitted) {
            for (let i = state.items.length - 1; i >= 0; i--) {
                const item = state.items[i]!;
                if (item.type !== 'tool' || item.stepRef || item.text !== input.label) continue;
                if ((item.agentId ?? 'main') !== (input.agentId ?? 'main')) continue;
                if (input.detail) item.detail = input.detail;
                if (input.status) {
                    item.status = input.status;
                    item.collapsed = settledCollapsed() && input.status !== 'running';
                }
                item.timestamp = Date.now();
                break;
            }
        }
        return false;
    }
    if (input.stepRef && state.committedToolRefs.has(input.stepRef)) {
        if (commitOpts?.updateCommitted && input.detail) {
            appendToolItem(state, input.label, {
                ...(input.agentId ? { agentId: input.agentId } : {}),
                detail: input.detail,
                stepRef: input.stepRef,
                status: input.status,
            });
        }
        return false;
    }
    if (input.stepRef) state.committedToolRefs.add(input.stepRef);
    else state.committedFallbackKeys.add(key);

    const detail = input.detail || live?.detail || '';
    const opts: Parameters<typeof appendToolItem>[2] = { detail, status: input.status };
    if (input.agentId) opts.agentId = input.agentId;
    if (input.stepRef) opts.stepRef = input.stepRef;
    appendToolItem(state, input.label, opts);
    return true;
}

/** 260703 CJ-WP3 — end-of-run reset: stepRef-less fallback dedup is scoped to
 *  ONE agent run. Cleared here (agent-done, after the toolLog replay) rather
 *  than only at user submits: /retry and external-message turns start runs
 *  WITHOUT a user item, and a stale key would suppress their fresh tool rows
 *  (B-verify High finding). */
export function resetTurnToolDedup(state: TranscriptState): void {
    state.committedFallbackKeys.clear();
}

export function commitRemainingLiveToolItems(state: TranscriptState, status: ToolEventInput['status'] = 'done'): number {
    const pending = [...state.liveTools];
    let committed = 0;
    for (const item of pending) {
        if (commitToolItemOnce(state, {
            icon: item.icon,
            label: item.label,
            detail: item.detail,
            status,
            ...(item.agentId ? { agentId: item.agentId } : {}),
            ...(item.stepRef ? { stepRef: item.stepRef } : {}),
        })) {
            committed += 1;
        }
    }
    state.liveTools.length = 0;
    state.liveToolsExpanded = verboseRenderMode;
    return committed;
}

export function clearLiveToolItems(state: TranscriptState): LiveToolItem[] {
    const items = [...state.liveTools];
    state.liveTools.length = 0;
    state.liveToolsExpanded = verboseRenderMode;
    return items;
}

export function listLiveToolItems(state: TranscriptState): LiveToolItem[] {
    return [...state.liveTools];
}

export function collapsePreviousTools(state: TranscriptState): void {
    if (verboseRenderMode) return;
    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i]!;
        if (item.type === 'tool' && !item.collapsed) item.collapsed = true;
        else if (item.type !== 'status') break;
    }
}

// fromIndex: items before it are committed to native scrollback — their
// pixels are frozen, so toggling them would only desync the live cell
// heights from what the terminal actually shows. Committed components are
// ineligible for the live expansion toggle.
export function toggleToolExpansion(state: TranscriptState, fromIndex = 0): boolean {
    if (verboseRenderMode) return false;
    const expandableItems = state.items
        .slice(Math.max(0, fromIndex))
        .filter(i => i.type === 'tool' || i.type === 'thinking');
    const hasLiveTools = state.liveTools.length > 0;
    if (expandableItems.length === 0 && !hasLiveTools) return false;
    const shouldExpand = expandableItems.some(i => i.collapsed !== false) || (hasLiveTools && !state.liveToolsExpanded);
    for (const item of expandableItems) item.collapsed = !shouldExpand;
    state.liveToolsExpanded = hasLiveTools ? shouldExpand : false;
    return true;
}

export function toggleLatestToolExpansion(state: TranscriptState): boolean {
    if (verboseRenderMode) return false;
    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i]!;
        if (item.type !== 'tool') continue;
        item.collapsed = !item.collapsed;
        return true;
    }
    return false;
}

export function appendStatusItem(state: TranscriptState, text: string): void {
    // Ephemeral — replace previous status if it exists
    clearEphemeralStatus(state);
    const last = state.items[state.items.length - 1];
    if (last?.type === 'status') {
        last.text = text;
        last.timestamp = Date.now();
        return;
    }
    state.items.push({ type: 'status', text, ephemeral: true, timestamp: Date.now() });
}

export function appendCommandItem(state: TranscriptState, text: string, opts?: { commandName?: string; ok?: boolean }): void {
    clearEphemeralStatus(state);
    const item: TranscriptItem = { type: 'command', text, timestamp: Date.now() };
    if (opts?.commandName) item.commandName = opts.commandName;
    if (typeof opts?.ok === 'boolean') item.ok = opts.ok;
    state.items.push(item);
}

export function clearEphemeralStatus(state: TranscriptState): void {
    for (let i = state.items.length - 1; i >= 0; i--) {
        if (state.items[i]?.type === 'status') state.items.splice(i, 1);
    }
}
