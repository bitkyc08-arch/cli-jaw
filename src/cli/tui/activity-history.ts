import type { RuntimeEvent } from '../../shared/runtime-contract.js';
import type { ActivityRunSummary, SavedActivityAnswer } from '../../shared/activity-read.js';
import { activityEntryLabel, activityEntryText } from '../../shared/activity-state.js';
import { renderActivityItem, type ActivityTranscriptItem } from './activity.js';
import { safeActivityTerminalText, wrapActivityTerminalText } from './activity-terminal-text.js';
import { fitCellGrapheme } from './cell-width.js';
import { splitKeyInput } from './keymap.js';

export interface ActivityHistoryPanel {
    open: boolean;
    runId: string | null;
    seq: number | null;
    offset: number;
    expanded: boolean;
    message: string;
    loading: boolean;
    runs: Array<Omit<ActivityRunSummary, 'status'> & { status: ActivityRunSummary['status'] | 'finished' }>;
    events: RuntimeEvent[];
    through: number;
    incomplete: boolean;
    loss: string | null;
    preview: ActivityTranscriptItem | null;
    controller: AbortController | null;
    generation: number;
    discoveryLimited: boolean;
    discoveryLoaded: boolean;
    discoveryAfter: string | null;
    sessionId: string | null;
    originalScope: string | null;
    answerView: boolean;
    answer: { kind: 'unloaded' | 'loading' | 'absent' | 'unavailable' }
        | { kind: 'saved'; message: SavedActivityAnswer };
}

/** Owned by stdin, independently of panel, session and read lifetimes. */
export interface ActivityPasteDrain {
    active: boolean;
    pending: string;
}

const DISCOVERY_RUNS = 256;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const LEGEND = ['F6/Esc close | ↑/↓ records | ←/→ runs | Enter detail', 'A saved answer | PgUp/PgDn scroll | Home/End | R reload | N more'];

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
type AnswerViewport = { rows: string[]; totalRows: number; offset: number };
const answerCache = new WeakMap<ActivityHistoryPanel, {
    message: SavedActivityAnswer; columns: number; height: number; offset: number; result: AnswerViewport;
}>();

/** Count incrementally, then retain only the selected viewport. Never allocate
 * wrap(fullAnswer) or a full grapheme array. Sanitize complete values first. */
export function sliceActivityAnswerViewport(text: string, columns: number, offset: number, height: number): AnswerViewport {
    const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
    const capacity = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    const safe = safeActivityTerminalText(text);
    const ascii = !/[^\x20-\x7e\n]/.test(safe);
    function scan(start: number, end: number, rows?: string[]): number {
        let row = 0, width = 0, value = '';
        const finish = () => {
            if (rows && row >= start && row < end) rows.push(value);
            row++; width = 0; value = '';
        };
        let from = 0;
        do {
            const newline = safe.indexOf('\n', from);
            const lineEnd = newline < 0 ? safe.length : newline;
            if (ascii) {
                // Empty logical lines (including terminal LF) each own one row;
                // an exact-width nonempty line owns no additional blank row.
                const count = Math.max(1, Math.ceil((lineEnd - from) / cols));
                if (rows) {
                    const first = Math.max(0, start - row);
                    const last = Math.min(count, end - row);
                    for (let index = first; index < last; index++) {
                        rows.push(safe.slice(from + index * cols, Math.min(lineEnd, from + (index + 1) * cols)));
                    }
                }
                row += count;
            } else {
                for (const { segment } of segmenter.segment(safe.slice(from, lineEnd))) {
                    const fitted = fitCellGrapheme(segment, cols);
                    if (width > 0 && width + fitted.width > cols) finish();
                    if (rows && row >= end) return row;
                    if (rows && row >= start) value += fitted.text;
                    width += fitted.width;
                }
                finish();
            }
            if (rows && row >= end) return row;
            if (newline < 0) break;
            from = newline + 1;
        } while (from <= safe.length);
        return row;
    }
    const totalRows = scan(0, 0);
    const requested = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const first = Math.min(requested, Math.max(0, totalRows - capacity));
    const rows: string[] = [];
    if (capacity) scan(first, first + capacity, rows);
    return { rows, totalRows, offset: first };
}

function savedViewport(panel: ActivityHistoryPanel, columns: number, height: number): AnswerViewport {
    if (panel.answer.kind !== 'saved') return { rows: [], totalRows: 0, offset: 0 };
    const cached = answerCache.get(panel);
    if (cached?.message === panel.answer.message && cached.columns === columns
        && cached.height === height && cached.offset === panel.offset) return cached.result;
    const result = sliceActivityAnswerViewport(panel.answer.message.content, columns, panel.offset, height);
    answerCache.set(panel, { message: panel.answer.message, columns, height, offset: panel.offset, result });
    return result;
}

function headingCount(panel: ActivityHistoryPanel): number {
    return 1 + Number(panel.sessionId !== null || panel.originalScope !== null) + Number(panel.loading)
        + Number(Boolean(panel.message)) + Number(panel.incomplete) + Number(Boolean(panel.loss)) + Number(panel.discoveryLimited);
}

export function setActivityHistoryAnswer(panel: ActivityHistoryPanel, answer: ActivityHistoryPanel['answer']): void {
    answerCache.delete(panel);
    panel.answer = answer;
}

export function createActivityHistoryPanel(): ActivityHistoryPanel {
    return { open: false, runId: null, seq: null, offset: 0, expanded: false, message: '', loading: false,
        runs: [], events: [], through: 0, incomplete: false, loss: null, preview: null,
        controller: null, generation: 0, discoveryLimited: false, discoveryLoaded: false, discoveryAfter: null,
        sessionId: null, originalScope: null, answerView: false, answer: { kind: 'unloaded' } };
}

function initialRecord(events: RuntimeEvent[]): number {
    const index = events.findIndex(event => event.kind === 'tool' || event.kind === 'message' || event.kind === 'reasoning');
    return index < 0 ? 0 : index;
}

function selectedRecord(panel: ActivityHistoryPanel): number {
    return panel.seq === null ? initialRecord(panel.events) : panel.events.findIndex(event => event.seq === panel.seq);
}

/** Local wrappers supply an immediate bounded preview; the controller owns discovery. */
export function openActivityHistory(panel: ActivityHistoryPanel, turns: ActivityTranscriptItem[]): void {
    panel.open = true;
    if (panel.discoveryLoaded) return;
    const runs = new Map(panel.runs.map(run => [run.id, run]));
    for (const turn of turns) {
        const id = turn.model.identity.runId;
        if (!runs.has(id)) runs.set(id, { id, messageId: null, startedAt: turn.timestamp,
            status: turn.terminalStatus === 'stopped' ? 'interrupted' : turn.terminalStatus ?? 'running' });
    }
    const discovered = [...runs.values()];
    panel.runs = discovered.slice(-DISCOVERY_RUNS);
    // Keep the inspected run navigable even after many newer local turns arrive.
    const selected = panel.runId === null ? undefined : runs.get(panel.runId);
    if (selected && !panel.runs.some(run => run.id === selected.id)) panel.runs[0] = selected;
    if (discovered.length > DISCOVERY_RUNS) panel.discoveryLimited = true;
    if (panel.runId === null) panel.runId = turns.at(-1)?.model.identity.runId ?? panel.runs.at(-1)?.id ?? null;
    panel.preview = panel.events.length ? null
        : turns.slice().reverse().find(turn => turn.model.identity.runId === panel.runId) ?? panel.preview;
    if (panel.seq === null && panel.events.length) panel.seq = panel.events[initialRecord(panel.events)]!.seq;
}

/** Move across canonical records, never across aggregated item IDs or numeric seq gaps. */
export function moveActivityHistory(panel: ActivityHistoryPanel, delta: number): void {
    panel.answerView = false;
    panel.offset = 0;
    if (!panel.events.length) { panel.seq = null; return; }
    panel.preview = null;
    const current = selectedRecord(panel);
    const index = current < 0 ? initialRecord(panel.events) : current;
    const next = Math.max(0, Math.min(panel.events.length - 1, index + Math.trunc(delta)));
    panel.seq = panel.events[next]!.seq;
}

/** Clear only the selected payload. Read cancellation and generation belong to main. */
export function moveActivityTurn(panel: ActivityHistoryPanel, delta: number): boolean {
    if (!panel.runs.length) return false;
    const current = panel.runs.findIndex(run => run.id === panel.runId);
    const next = current < 0 ? (delta < 0 ? panel.runs.length - 1 : 0)
        : Math.max(0, Math.min(panel.runs.length - 1, current + Math.trunc(delta)));
    const id = panel.runs[next]!.id;
    if (id === panel.runId) return false;
    panel.runId = id;
    panel.originalScope = null;
    panel.answerView = false;
    panel.answer = { kind: 'unloaded' };
    answerCache.delete(panel);
    panel.events = [];
    panel.seq = null;
    panel.offset = 0;
    panel.through = 0;
    panel.incomplete = false;
    panel.loss = null;
    panel.preview = null;
    panel.message = '';
    panel.loading = false;
    return true;
}

function recordLabel(event: RuntimeEvent): string {
    let label: string;
    switch (event.kind) {
        case 'tool': label = activityEntryLabel(event); break;
        case 'message': case 'reasoning': label = `${activityEntryLabel(event)} | ${event.operation}`; break;
        case 'turn-start': label = `Turn started | ${event.provider}`; break;
        case 'turn-end': label = `Turn ended | ${event.status}`; break;
        case 'request': label = `Read-only ${event.requestType} request | ${event.view.title}`; break;
        case 'request-settled': label = 'Read-only request settled'; break;
        case 'usage': label = 'Usage'; break;
    }
    return `seq ${event.seq} | ${label}`;
}

const fieldText = (value: string | undefined): string => value === undefined ? 'absent' : value === '' ? '(empty)' : value;

function recordBody(event: RuntimeEvent): string {
    switch (event.kind) {
        case 'message': case 'reasoning':
            return `Item: ${event.itemId}\n${event.kind === 'message' ? `Phase: ${event.phase}\n` : ''}`
                + `Text: ${fieldText(activityEntryText(event))}`;
        case 'tool':
            return `Item: ${event.itemId}\n` + activityEntryText({ ...event,
                input: `Input: ${fieldText(event.input)}`, output: `Output: ${fieldText(event.output)}`,
                detail: `Detail: ${fieldText(event.detail)}` });
        case 'turn-start': return `Provider: ${event.provider}`;
        case 'turn-end':
            return (event.finalText === null ? 'Journal preview (redacted): absent (null)'
                : event.finalText === '' ? 'Journal preview (redacted): empty'
                    : `Journal preview (redacted):\n${event.finalText}`)
                + (event.error === undefined ? '' : `\nError: ${fieldText(event.error)}`);
        case 'usage':
            return `inputTokens: ${event.inputTokens ?? 'absent'}\noutputTokens: ${event.outputTokens ?? 'absent'}`
                + `\ncachedTokens: ${event.cachedTokens ?? 'absent'}`;
        case 'request-settled': return `Request: ${event.requestId}\nRead-only; already settled.`;
        case 'request':
            return [`Request: ${event.requestId}`, 'Read-only; responses are unavailable in history.',
                `Title: ${event.view.title}`, ...event.view.fields.flatMap(field => [
                    `Field: ${field.id} | ${field.label}`,
                    `multiSelect: ${field.multiSelect} | allowFreeform: ${field.allowFreeform}`,
                    ...field.options.map(option => `Option: ${option.id} | ${option.label}`),
                ])].join('\n');
    }
}

function recordDetails(event: RuntimeEvent, columns: number): string[] {
    const identity = `Run: ${event.runId}\nSession: ${event.sessionId}\nScope: ${event.scope}\nTurn: ${event.turnId}`
        + `\nVersion: ${event.version}\nKind: ${event.kind}`
        + (event.parentItemId === undefined ? '' : `\nParent: ${event.parentItemId}`);
    // Sanitize whole fields before slicing the viewport, preserving control-string context.
    return wrapActivityTerminalText(`${identity}\n${recordBody(event)}`, columns);
}

export function activityHistoryScrollLimit(panel: ActivityHistoryPanel, columns: number, height: number): number {
    const headings = headingCount(panel);
    const footer = Math.min(2, Math.max(0, height - 2));
    const available = Math.max(0, height - headings - footer - 1);
    if (panel.answerView) return Math.max(0, savedViewport(panel, columns, available).totalRows - available);
    const event = panel.events[selectedRecord(panel)];
    if (!event || !panel.expanded) return 0;
    return Math.max(0, recordDetails(event, columns).length - available);
}

/** Render only the viewport; selection and scrolling are never changed by live updates. */
export function renderActivityHistory(panel: ActivityHistoryPanel, columns: number, height: number): string[] {
    if (!panel.open || !Number.isFinite(columns) || !Number.isFinite(height) || columns < 1 || height < 1) return [];
    const cols = Math.floor(columns);
    const rows = Math.floor(height);
    const line = (text: string) => wrapActivityTerminalText(text, cols)[0]!;
    const header = [line(`Activity history | ${panel.runId ?? 'No run'} | through ${panel.through}`)];
    if (panel.sessionId !== null || panel.originalScope !== null)
        header.push(line(`Session: ${panel.sessionId ?? 'unloaded'} | Original scope: ${panel.originalScope ?? 'unloaded'}`));
    if (panel.loading) header.push(line('Loading retained Activity history…'));
    if (panel.message) header.push(line(panel.message));
    if (panel.incomplete) header.push(line('Retained history incomplete; earlier records may be unavailable.'));
    if (panel.loss) header.push(line(`Durable gap: ${panel.loss}`));
    if (panel.discoveryLimited) header.push(line('Run list limited; N loads the next list.'));
    const legend = cols <= 30 ? ['Arrows Enter Esc/F6', 'A Pg R retry N more']
        : cols < 60 ? ['Arrows Enter detail Esc/F6 close', 'A saved answer Pg R reload N more'] : LEGEND;
    const footer = legend.map(line)
        .slice(0, Math.min(2, Math.max(0, rows - 2)));
    const available = Math.max(0, rows - header.length - footer.length);
    const body: string[] = [];
    if (available > 0) {
        const index = selectedRecord(panel);
        const selected = panel.events[index];
        if (panel.answerView) {
            const answer = panel.answer;
            body.push(line(cols <= 30 ? 'Saved (read-only)'
                : cols < 60 ? 'Saved answer (read-only)' : 'Saved answer (MESSAGE, read-only)'));
            if (answer.kind === 'saved') {
                if (answer.message.content === '') body.push(line(cols < 60 ? 'Saved: empty' : 'Saved answer: authoritative empty'));
                else body.push(...savedViewport(panel, cols, Math.max(0, available - 1)).rows);
            } else {
                const message = answer.kind === 'loading' ? 'Loading saved answer…'
                    : answer.kind === 'absent' ? (cols < 60 ? 'No saved answer' : 'No saved answer (MESSAGE is absent).')
                    : answer.kind === 'unavailable' ? (cols < 60 ? 'Read failed: R retry' : 'Saved answer unavailable. R retries.')
                    : 'Saved answer not loaded. R loads it.';
                body.push(line(message));
            }
        } else if (!panel.events.length) {
            if (panel.preview) {
                body.push(line('Live preview — retained records not loaded'));
                body.push(...renderActivityItem(panel.preview, cols).slice(0, available - 1));
            } else body.push(line(panel.runId === null ? 'No Activity runs. R reloads history.' : 'No retained events. R reloads history.'));
        } else if (!selected) {
            body.push(line(`Selected seq ${panel.seq} not retained. ↑/↓ selects an available record; R retries.`));
        } else if (panel.expanded) {
            body.push(line(`> ${recordLabel(selected)}`));
            const details = recordDetails(selected, cols);
            const capacity = Math.max(0, available - 1);
            const offset = Math.max(0, Math.min(Math.max(0, details.length - capacity), Math.floor(panel.offset)));
            body.push(...details.slice(offset, offset + capacity));
        } else {
            const first = Math.max(0, Math.min(index - Math.floor(available / 2), panel.events.length - available));
            for (let pos = first; pos < Math.min(panel.events.length, first + available); pos++) {
                body.push(line(`${pos === index ? '>' : ' '} ${recordLabel(panel.events[pos]!)}`));
            }
        }
    }
    return [...header.slice(0, rows - footer.length), ...body.slice(0, available), ...footer].slice(0, rows);
}

export function createActivityPasteDrain(): ActivityPasteDrain {
    return { active: false, pending: '' };
}

/**
 * Feed before key dispatch. Only a possible marker prefix survives a call (<=5 chars).
 * Empty input flushes an outside-paste prefix for main's delayed Escape timer; while
 * active it does nothing. No close/reset operation clears this independent drain.
 * Main discards ALL returned tokens from a chunk completing a drain while closed.
 */
export function consumeActivityHistoryInput(drain: ActivityPasteDrain, input: string): string[] {
    if (!input) {
        if (drain.active) return [];
        const pending = drain.pending;
        drain.pending = '';
        return splitKeyInput(pending);
    }
    const source = drain.pending + input;
    drain.pending = '';
    const keys: string[] = [];
    let offset = 0;
    while (offset < source.length) {
        const marker = drain.active ? PASTE_END : PASTE_START;
        const end = source.indexOf(marker, offset);
        if (end >= 0) {
            if (!drain.active) keys.push(...splitKeyInput(source.slice(offset, end)));
            drain.active = !drain.active;
            offset = end + marker.length;
            continue;
        }
        let prefix = Math.min(marker.length - 1, source.length - offset);
        while (prefix > 0 && !source.endsWith(marker.slice(0, prefix))) prefix--;
        drain.pending = prefix ? source.slice(-prefix) : '';
        if (!drain.active) keys.push(...splitKeyInput(source.slice(offset, source.length - prefix)));
        break;
    }
    return keys;
}
