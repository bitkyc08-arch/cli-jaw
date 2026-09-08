import { getArgumentCompletionItems, getCompletionItems } from '../commands.js';
import { clipTextToCols, visualWidth } from './renderers.js';
import type { OverlayItem } from '../types.js';

export interface AutocompleteState {
    open: boolean;
    stage: string;
    contextHeader: string;
    items: OverlayItem[];
    selected: number;
    windowStart: number;
    visibleRows: number;
    renderedRows: number;
    maxRowsCommand: number;
    maxRowsArgument: number;
}

export interface ResolvedAutocompleteState {
    open: boolean;
    stage?: string;
    contextHeader?: string;
    items: OverlayItem[];
    selected: number;
    visibleRows: number;
}

export interface ResolveAutocompleteOptions {
    draft: string | null;
    prevKey: string;
    maxPopupRows: number;
    maxRowsCommand: number;
    maxRowsArgument: number;
    getCommandItems?: (draft: string) => any[];
    getArgumentItems?: (commandName: string, partial: string, argv: string[]) => any[];
}

export interface RenderAutocompleteOptions {
    write: (chunk: string) => void;
    columns: number;
    dimCode: string;
    resetCode: string;
    clipTextToCols: (str: string, maxCols: number) => string;
}

export function createAutocompleteState(): AutocompleteState {
    return {
        open: false,
        stage: 'command',
        contextHeader: '',
        items: [],
        selected: 0,
        windowStart: 0,
        visibleRows: 0,
        renderedRows: 0,
        maxRowsCommand: 6,
        maxRowsArgument: 8,
    };
}

export function makeSelectionKey(item: OverlayItem | null | undefined, stage: string): string {
    if (!item) return '';
    const base = item.command ? `${item.command}:${item.name}` : item.name;
    return `${stage}:${base}`;
}

export function popupTotalRows(state: { open: boolean; visibleRows: number; contextHeader?: string }): number {
    if (!state.open) return 0;
    return state.visibleRows + (state.contextHeader ? 1 : 0);
}

export function syncAutocompleteWindow(state: AutocompleteState): void {
    if (!state.items.length || state.visibleRows <= 0) {
        state.windowStart = 0;
        return;
    }
    state.selected = Math.max(0, Math.min(state.selected, state.items.length - 1));
    const maxStart = Math.max(0, state.items.length - state.visibleRows);
    state.windowStart = Math.max(0, Math.min(state.windowStart, maxStart));
    if (state.selected < state.windowStart) state.windowStart = state.selected;
    if (state.selected >= state.windowStart + state.visibleRows) {
        state.windowStart = state.selected - state.visibleRows + 1;
    }
}

export async function resolveAutocompleteState(options: ResolveAutocompleteOptions): Promise<ResolvedAutocompleteState> {
    const {
        draft,
        prevKey,
        maxPopupRows,
        maxRowsCommand,
        maxRowsArgument,
        getCommandItems = (value) => getCompletionItems(value, 'cli'),
        getArgumentItems = (commandName, partial, argv) => getArgumentCompletionItems(commandName, partial, 'cli', argv, {}),
    } = options;

    if (!draft || !draft.startsWith('/')) {
        return { open: false, items: [], selected: 0, visibleRows: 0 };
    }

    const body = draft.slice(1);
    const firstSpace = body.indexOf(' ');
    let stage = 'command';
    let contextHeader = '';
    let items: OverlayItem[] = [];

    if (firstSpace === -1) {
        items = getCommandItems(draft);
    } else {
        const commandName = body.slice(0, firstSpace).trim().toLowerCase();
        if (!commandName) return { open: false, items: [], selected: 0, visibleRows: 0 };

        const rest = body.slice(firstSpace + 1);
        const endsWithSpace = /\s$/.test(rest);
        const tokens = rest.trim() ? rest.trim().split(/\s+/) : [];
        const partial = endsWithSpace ? '' : (tokens[tokens.length - 1] || '');
        const argv = endsWithSpace ? tokens : tokens.slice(0, -1);

        items = await Promise.resolve(getArgumentItems(commandName, partial, argv)) as OverlayItem[];
        if (items.length) {
            stage = 'argument';
            contextHeader = `${commandName} ▸ ${items[0]?.commandDesc || '인자 선택'}`;
        }
    }

    if (!items.length) {
        return { open: false, items: [], selected: 0, visibleRows: 0 };
    }

    const selected = (() => {
        if (!prevKey) return 0;
        const idx = items.findIndex(item => makeSelectionKey(item, stage) === prevKey);
        return idx >= 0 ? idx : 0;
    })();

    const headerRows = contextHeader ? 1 : 0;
    const maxItemRows = Math.max(0, maxPopupRows - headerRows);
    const stageCap = stage === 'argument' ? maxRowsArgument : maxRowsCommand;
    const visibleRows = Math.min(stageCap, items.length, maxItemRows);

    if (visibleRows <= 0) {
        return { open: false, items: [], selected: 0, visibleRows: 0 };
    }

    return { open: true, stage, contextHeader, items, selected, visibleRows };
}

export function resetAutocompleteState(state: AutocompleteState): void {
    state.open = false;
    state.stage = 'command';
    state.contextHeader = '';
    state.items = [];
    state.selected = 0;
    state.windowStart = 0;
    state.visibleRows = 0;
}

export function applyResolvedAutocompleteState(state: AutocompleteState, next: ResolvedAutocompleteState): void {
    if (!next.open) {
        resetAutocompleteState(state);
        return;
    }
    state.open = true;
    state.stage = next.stage ?? 'command';
    state.contextHeader = next.contextHeader || '';
    state.items = next.items;
    state.selected = next.selected;
    state.visibleRows = next.visibleRows;
    syncAutocompleteWindow(state);
}

export function clearAutocomplete(state: AutocompleteState, write: (chunk: string) => void): void {
    if (state.renderedRows <= 0) return;
    write('\x1b[s');
    for (let row = 1; row <= state.renderedRows; row++) {
        write(`\x1b[${row}B\r\x1b[2K\x1b[${row}A`);
    }
    write('\x1b[u');
    state.renderedRows = 0;
}

export function closeAutocomplete(state: AutocompleteState, write: (chunk: string) => void): void {
    clearAutocomplete(state, write);
    resetAutocompleteState(state);
}

export function formatAutocompleteLine(
    item: OverlayItem,
    selected: boolean,
    stage: string,
    options: Pick<RenderAutocompleteOptions, 'columns' | 'dimCode' | 'resetCode' | 'clipTextToCols'>,
): string {
    const value = stage === 'argument' ? item.name : `/${item.name}`;
    const valueCol = stage === 'argument' ? 24 : 14;
    const valueText = value.length >= valueCol ? value.slice(0, valueCol) : value.padEnd(valueCol, ' ');
    const desc = item.desc || '';
    const raw = `  ${valueText}  ${desc}`;
    const line = options.clipTextToCols(raw, options.columns - 2);
    return selected ? `\x1b[7m${line}${options.resetCode}` : `${options.dimCode}${line}${options.resetCode}`;
}

/** Frame-safe autocomplete lines (no cursor motion escapes). */
export function composeAutocompleteLines(
    state: AutocompleteState,
    options: Pick<RenderAutocompleteOptions, 'columns' | 'dimCode' | 'resetCode' | 'clipTextToCols'>,
): string[] {
    if (!state.open || state.items.length === 0 || state.visibleRows <= 0) return [];
    syncAutocompleteWindow(state);
    const lines: string[] = [];
    if (state.contextHeader) {
        lines.push(options.clipTextToCols(`  ${state.contextHeader}`, options.columns - 2));
    }
    const start = state.windowStart;
    const end = Math.min(state.items.length, start + state.visibleRows);
    for (let i = start; i < end; i++) {
        const item = state.items[i];
        if (!item) continue;
        lines.push(formatAutocompleteLine(item, i === state.selected, state.stage, options));
    }
    return lines;
}

export function renderAutocomplete(state: AutocompleteState, options: RenderAutocompleteOptions): void {
    clearAutocomplete(state, options.write);
    if (!state.open || state.items.length === 0 || state.visibleRows <= 0) return;

    syncAutocompleteWindow(state);
    const start = state.windowStart;
    const end = Math.min(state.items.length, start + state.visibleRows);
    const headerRows = state.contextHeader ? 1 : 0;
    options.write('\x1b[s');

    if (headerRows) {
        options.write('\x1b[1B\r\x1b[2K');
        const header = options.clipTextToCols(`  ${state.contextHeader}`, options.columns - 2);
        options.write(`${options.dimCode}${header}${options.resetCode}`);
        options.write('\x1b[1A');
    }

    for (let i = start; i < end; i++) {
        const row = (i - start) + 1 + headerRows;
        const item = state.items[i];
        if (!item) continue;
        options.write(`\x1b[${row}B\r\x1b[2K`);
        options.write(formatAutocompleteLine(item, i === state.selected, state.stage, options));
        options.write(`\x1b[${row}A`);
    }

    state.renderedRows = headerRows + (end - start);
    options.write('\x1b[u');
}

// ─── Centered box (shared line + frame painters) ───

export interface CenteredBoxLayout {
    boxWidth: number;
    boxHeight: number;
    startRow: number;
    startCol: number;
    innerW: number;
}

export function layoutCenteredBox(
    cols: number,
    rows: number,
    innerLineCount: number,
    boxWidthCap: number,
    verticalMargin = 4,
): CenteredBoxLayout {
    const boxWidth = Math.min(boxWidthCap, cols - 4);
    const innerW = boxWidth - 2;
    const boxHeight = Math.min(innerLineCount + 2, rows - verticalMargin);
    const startRow = Math.max(1, Math.floor((rows - boxHeight) / 2));
    const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));
    return { boxWidth, boxHeight, startRow, startCol, innerW };
}

// ANSI-aware pad/clip: inner lines carry color escapes (bgtask rows, dim
// hints) — clipping by string length cut visible text mid-word and leaked an
// unclosed escape into the box border.
// clipTextToCols passes CSI sequences through and appends a reset when any
// ANSI was seen; visualWidth ignores escapes and counts wide glyphs as 2.
function padInner(text: string, innerW: number): string {
    const width = visualWidth(text);
    if (width > innerW) return clipTextToCols(text, innerW);
    return text + ' '.repeat(innerW - width);
}

/** Paint a bordered box into alt-screen frame rows (no cursor motion). */
export function paintCenteredBox(
    frameRows: string[],
    cols: number,
    rows: number,
    topInner: string,
    innerLines: string[],
    boxWidthCap: number,
): CenteredBoxLayout {
    const spec = layoutCenteredBox(cols, rows, innerLines.length, boxWidthCap);
    const hLine = '─'.repeat(spec.innerW);

    const setRow = (relRow: number, segment: string) => {
        const absRow = spec.startRow + relRow - 1;
        if (absRow < 1 || absRow > rows) return;
        const leftPad = ' '.repeat(spec.startCol - 1);
        // ANSI-safe clip: a raw slice counted escape bytes as columns and cut
        // the right border off colored rows (adversarial review, doc 40).
        frameRows[absRow - 1] = clipTextToCols(leftPad + segment, cols);
    };

    setRow(1, `┌${topInner}${'─'.repeat(Math.max(0, spec.innerW - topInner.length))}┐`);

    const visibleInner = Math.min(innerLines.length, spec.boxHeight - 2);
    for (let i = 0; i < visibleInner; i++) {
        const text = innerLines[i] ?? '';
        setRow(2 + i, `│${padInner(text, spec.innerW)}│`);
    }
    setRow(spec.boxHeight, `└${hLine}┘`);
    return spec;
}

function writeCenteredBox(
    write: (chunk: string) => void,
    cols: number,
    rows: number,
    topInner: string,
    innerLines: string[],
    boxWidthCap: number,
): number {
    const spec = layoutCenteredBox(cols, rows, innerLines.length, boxWidthCap);
    const hLine = '─'.repeat(spec.innerW);

    write('\x1b[?25l');
    write(`\x1b[${spec.startRow};${spec.startCol}H┌${topInner}${'─'.repeat(Math.max(0, spec.innerW - topInner.length))}┐`);

    const visibleInner = Math.min(innerLines.length, spec.boxHeight - 2);
    for (let i = 0; i < visibleInner; i++) {
        const r = spec.startRow + 1 + i;
        const text = innerLines[i] ?? '';
        write(`\x1b[${r};${spec.startCol}H│${padInner(text, spec.innerW)}│`);
    }

    write(`\x1b[${spec.startRow + spec.boxHeight - 1};${spec.startCol}H└${hLine}┘`);
    write('\x1b[?25h');
    return spec.boxHeight;
}

// ─── Help overlay ────────────────────────────

export interface HelpEntry {
    key: string;
    desc: string;
}

const HELP_ENTRIES: HelpEntry[] = [
    { key: 'Enter',        desc: 'submit message' },
    { key: 'Option+Enter', desc: 'newline' },
    { key: 'Tab',          desc: 'autocomplete accept' },
    { key: 'Ctrl+C',       desc: 'stop agent / exit' },
    { key: 'Ctrl+U',       desc: 'clear line' },
    { key: 'Ctrl+K',       desc: 'command palette' },
    { key: 'Ctrl+O',       desc: 'background tasks' },
    { key: '?',            desc: 'this help' },
    { key: '/',            desc: 'slash commands (type to filter)' },
    { key: 'Up/Down',      desc: 'autocomplete navigate' },
    { key: 'Esc',          desc: 'close popup / stop' },
];

export function buildHelpInnerLines(
    dimCode: string,
    resetCode: string,
    extraCommands?: { name: string; desc: string }[],
): string[] {
    const keyCol = 16;
    const lines: string[] = [];

    for (const e of HELP_ENTRIES) {
        lines.push(`  ${e.key.padEnd(keyCol)}${e.desc}`);
    }

    if (extraCommands?.length) {
        lines.push('');
        lines.push('  Slash commands:');
        for (const cmd of extraCommands.slice(0, 8)) {
            lines.push(`  ${('/' + cmd.name).padEnd(keyCol)}${cmd.desc || ''}`);
        }
        if (extraCommands.length > 8) {
            lines.push(`  ${dimCode}... +${extraCommands.length - 8} more (use Ctrl+K)${resetCode}`);
        }
    }

    lines.push('');
    lines.push(`  ${dimCode}Press Escape to close${resetCode}`);
    return lines;
}

export function composeHelpOntoFrame(
    frameRows: string[],
    cols: number,
    rows: number,
    dimCode: string,
    resetCode: string,
    extraCommands?: { name: string; desc: string }[],
): void {
    const inner = buildHelpInnerLines(dimCode, resetCode, extraCommands);
    paintCenteredBox(frameRows, cols, rows, '─ Help ', inner, 52);
}

export function renderHelpOverlay(
    write: (chunk: string) => void,
    cols: number,
    rows: number,
    dimCode: string,
    resetCode: string,
    extraCommands?: { name: string; desc: string }[],
): number {
    const inner = buildHelpInnerLines(dimCode, resetCode, extraCommands);
    return writeCenteredBox(write, cols, rows, '─ Help ', inner, 52);
}

export interface BgtaskOverlayItem {
    id: string;
    kind: string;
    status: string;
    elapsed: string;
    /** "2m30s ago" hint for terminal rows. */
    ago?: string;
    /** Epoch ms used for the recent-first sort within a rank. */
    sortKey?: number;
}

/** Compact duration tiers: 123ms \u00B7 1.5s \u00B7 30m15s \u00B7 2h30m \u00B7 3d2h. */
export function formatBgtaskDuration(ms: number): string {
    const SEC = 1000, MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
    if (ms < SEC) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < MIN) return `${(ms / SEC).toFixed(1)}s`;
    if (ms < HOUR) {
        const mins = Math.floor(ms / MIN);
        const secs = Math.floor((ms % MIN) / SEC);
        return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
    }
    if (ms < DAY) {
        const hours = Math.floor(ms / HOUR);
        const mins = Math.floor((ms % HOUR) / MIN);
        return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
    }
    const days = Math.floor(ms / DAY);
    const hours = Math.floor((ms % DAY) / HOUR);
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

const BGTASK_ATTENTION_STATUSES = new Set(['failed', 'cancelled', 'orphaned']);

/** Sort attention rows first, then running,
 *  then the rest; most recent first within the same rank. */
export function sortBgtaskItems(items: BgtaskOverlayItem[]): BgtaskOverlayItem[] {
    const rank = (it: BgtaskOverlayItem): number =>
        BGTASK_ATTENTION_STATUSES.has(it.status) ? 0 : it.status === 'running' ? 1 : 2;
    return [...items].sort((a, b) => rank(a) - rank(b) || (b.sortKey ?? 0) - (a.sortKey ?? 0));
}

export interface BgtaskOverlayColors {
    accent: string;
    success: string;
    error: string;
    warning: string;
}

const BGTASK_DEFAULT_COLORS: BgtaskOverlayColors = {
    accent: '\x1b[36m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m',
};

// Row style: `{icon} {kind} {label} \u00B7 {hint}` with the
// unicode symbol preset (\u2714 \u2718 \u23F9 \u26A0 \u27F3) and ` \u00B7 ` separators; attention rows
// (failed/orphaned) carry warning color and sort first.
export function buildBgtaskInnerLines(
    dimCode: string,
    resetCode: string,
    items: BgtaskOverlayItem[],
    colors: BgtaskOverlayColors = BGTASK_DEFAULT_COLORS,
): string[] {
    const lines: string[] = [];
    if (items.length === 0) {
        lines.push(`  ${dimCode}No background tasks${resetCode}`);
    } else {
        for (const it of sortBgtaskItems(items).slice(0, 10)) {
            const icon = it.status === 'running' ? `${colors.accent}\u27F3${resetCode}`
                : it.status === 'complete' ? `${colors.success}\u2714${resetCode}`
                    : it.status === 'cancelled' ? `${colors.error}\u23F9${resetCode}`
                        : it.status === 'orphaned' ? `${colors.warning}\u26A0${resetCode}`
                            : `${colors.error}\u2718${resetCode}`;
            const kindCol = it.kind.padEnd(7).slice(0, 7);
            const label = it.id.slice(3, 11);
            const attention = it.status === 'failed' || it.status === 'orphaned';
            const labelStyled = attention ? `${colors.warning}${label}${resetCode}` : label;
            const hint = it.status === 'running'
                ? (it.elapsed ? ` ${dimCode}\u00B7 ${it.elapsed}${resetCode}` : '')
                : ` ${dimCode}\u00B7 ${it.status}${it.ago ? ` \u00B7 ${it.ago}` : ''}${resetCode}`;
            lines.push(`  ${icon} ${kindCol} ${labelStyled}${hint}`);
        }
        if (items.length > 10) lines.push(`  ${dimCode}... +${items.length - 10} more (cli-jaw bgtask list)${resetCode}`);
    }
    lines.push('');
    lines.push(`  ${dimCode}Press Escape or Ctrl+O to close${resetCode}`);
    return lines;
}

export function composeBgtaskOntoFrame(
    frameRows: string[],
    cols: number,
    rows: number,
    dimCode: string,
    resetCode: string,
    items: BgtaskOverlayItem[],
): void {
    const inner = buildBgtaskInnerLines(dimCode, resetCode, items);
    paintCenteredBox(frameRows, cols, rows, '\u2500 Background Tasks ', inner, 52);
}

export function renderBgtaskOverlay(
    write: (chunk: string) => void,
    cols: number,
    rows: number,
    dimCode: string,
    resetCode: string,
    items: BgtaskOverlayItem[],
): number {
    const inner = buildBgtaskInnerLines(dimCode, resetCode, items);
    return writeCenteredBox(write, cols, rows, '\u2500 Background Tasks ', inner, 52);
}

export function clearOverlayBox(
    write: (chunk: string) => void,
    cols: number,
    rows: number,
    boxHeight: number,
): void {
    const boxWidth = Math.min(52, cols - 4);
    const startRow = Math.max(1, Math.floor((rows - boxHeight) / 2));
    const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));
    const blank = ' '.repeat(boxWidth);
    for (let i = 0; i < boxHeight; i++) {
        write(`\x1b[${startRow + i};${startCol}H${blank}`);
    }
}

// ─── Command palette ─────────────────────────

export interface PaletteRenderOptions {
    write: (chunk: string) => void;
    cols: number;
    rows: number;
    dimCode: string;
    resetCode: string;
    filter: string;
    items: { name: string; desc: string }[];
    selected: number;
}

export function buildPaletteInnerLines(
    dimCode: string,
    resetCode: string,
    filter: string,
    items: { name: string; desc: string }[],
    selected: number,
    maxItems: number,
): string[] {
    const lines: string[] = [];
    lines.push(`  > ${filter}`);
    lines.push('');

    for (let i = 0; i < maxItems; i++) {
        const item = items[i];
        if (!item) {
            lines.push('');
            continue;
        }
        const nameStr = ('  /' + item.name).padEnd(16);
        const descStr = item.desc || '';
        let line = `${nameStr}${descStr}`;
        if (i === selected) {
            line = `\x1b[7m${line}${resetCode}`;
        } else {
            line = `${dimCode}${line}${resetCode}`;
        }
        lines.push(line);
    }

    lines.push(`${dimCode} ↑↓ navigate  Enter select  Esc close${resetCode}`);
    return lines;
}

export function composePaletteOntoFrame(
    frameRows: string[],
    cols: number,
    rows: number,
    dimCode: string,
    resetCode: string,
    filter: string,
    items: { name: string; desc: string }[],
    selected: number,
): void {
    const maxItems = Math.min(items.length, rows - 8, 12);
    const inner = buildPaletteInnerLines(dimCode, resetCode, filter, items, selected, maxItems);
    paintCenteredBox(frameRows, cols, rows, '─ Commands ', inner, 52);
}

export function renderCommandPalette(opts: PaletteRenderOptions): number {
    const { write, cols, rows, dimCode, resetCode, filter, items, selected } = opts;

    const maxItems = Math.min(items.length, rows - 8, 12);
    const inner = buildPaletteInnerLines(dimCode, resetCode, filter, items, selected, maxItems);
    return writeCenteredBox(write, cols, rows, '─ Commands ', inner, 52);
}

// ─── Choice selector overlay ─────────────────

export interface ChoiceSelectorItem {
    value: string;
    label: string;
    current?: boolean;
}

export interface ChoiceSelectorRenderOptions {
    write: (chunk: string) => void;
    cols: number;
    rows: number;
    dimCode: string;
    resetCode: string;
    title: string;
    subtitle: string;
    filter: string;
    items: ChoiceSelectorItem[];
    selected: number;
}

export function filterSelectorItems(items: ChoiceSelectorItem[], filter: string): ChoiceSelectorItem[] {
    if (!filter) return items;
    const q = filter.toLowerCase();
    return items.filter(item =>
        item.value.toLowerCase().includes(q) || item.label.toLowerCase().includes(q),
    );
}

export function buildSelectorInnerLines(
    dimCode: string,
    resetCode: string,
    subtitle: string,
    filter: string,
    items: ChoiceSelectorItem[],
    selected: number,
    maxItems: number,
): string[] {
    const lines: string[] = [];
    lines.push(`  ${dimCode}${subtitle}${resetCode}`);
    lines.push(`  > ${filter}█`);
    lines.push(`  ${dimCode}${'─'.repeat(20)}${resetCode}`);

    for (let i = 0; i < maxItems; i++) {
        const item = items[i];
        if (!item) {
            lines.push('');
            continue;
        }
        const marker = item.current ? '●' : ' ';
        const valueStr = item.value;
        const labelStr = item.label ? `  ${dimCode}${item.label}${resetCode}` : '';
        let line = `  ${marker} ${valueStr}${labelStr}`;
        if (i === selected) {
            line = `\x1b[7m${line}${resetCode}`;
        }
        lines.push(line);
    }

    lines.push(`${dimCode} ↑↓ navigate  Enter select  Esc cancel${resetCode}`);
    return lines;
}

export function composeSelectorOntoFrame(
    frameRows: string[],
    cols: number,
    rows: number,
    dimCode: string,
    resetCode: string,
    title: string,
    subtitle: string,
    filter: string,
    items: ChoiceSelectorItem[],
    selected: number,
): void {
    const maxItems = Math.min(items.length, rows - 10, 14);
    const inner = buildSelectorInnerLines(dimCode, resetCode, subtitle, filter, items, selected, maxItems);
    const titleStr = ` ${title} `;
    paintCenteredBox(frameRows, cols, rows, `─${titleStr}`, inner, 60);
}

export function renderChoiceSelector(opts: ChoiceSelectorRenderOptions): number {
    const { write, cols, rows, dimCode, resetCode, title, subtitle, filter, items, selected } = opts;

    const maxItems = Math.min(items.length, rows - 10, 14);
    const inner = buildSelectorInnerLines(dimCode, resetCode, subtitle, filter, items, selected, maxItems);
    const titleStr = ` ${title} `;
    return writeCenteredBox(write, cols, rows, `─${titleStr}`, inner, 60);
}
