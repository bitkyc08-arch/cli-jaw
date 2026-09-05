import { toGraphemes } from './text-buffer.js';
import { graphemeCellWidth, fitCellGrapheme } from './cell-width.js';

const RESET = '\x1b[0m';
const MAX_SGR_CARRY = 128;
interface StyledCell { text: string; plain: string; width: number; ansi: string[]; }

function parseAnsiCsi(text: string, pos: number): { value: string; next: number } | null {
    if (text.charCodeAt(pos) !== 0x1b || text[pos + 1] !== '[') return null;
    let end = pos + 2;
    while (end < text.length && !(text.charCodeAt(end) >= 0x40 && text.charCodeAt(end) <= 0x7e)) end++;
    return end < text.length ? { value: text.slice(pos, end + 1), next: end + 1 } : null;
}

/** Segment visible text once; CSI offsets can occur even inside one grapheme. */
function* styledCells(text: string): Generator<StyledCell> {
    const visibleParts: string[] = [];
    const styles: Array<{ offset: number; value: string }> = [];
    let pos = 0;
    let length = 0;
    while (pos < text.length) {
        const start = text.indexOf('\x1b[', pos);
        const part = text.slice(pos, start < 0 ? text.length : start);
        visibleParts.push(part);
        length += part.length;
        if (start < 0) break;
        const ansi = parseAnsiCsi(text, start);
        if (!ansi) break; // An incomplete CSI tail must never escape a row.
        styles.push({ offset: length, value: ansi.value });
        pos = ansi.next;
    }
    const visible = visibleParts.join('');
    let offset = 0;
    let style = 0;
    for (const plain of toGraphemes(visible)) {
        const end = offset + plain.length;
        const parts: string[] = [];
        const ansi: string[] = [];
        let cursor = offset;
        while (style < styles.length && styles[style]!.offset < end) {
            const entry = styles[style++]!;
            parts.push(visible.slice(cursor, entry.offset), entry.value);
            ansi.push(entry.value);
            cursor = entry.offset;
        }
        parts.push(visible.slice(cursor, end));
        yield { text: parts.join(''), plain, width: graphemeCellWidth(plain), ansi };
        offset = end;
    }
    if (style < styles.length) {
        const ansi = styles.slice(style).map(entry => entry.value);
        yield { text: ansi.join(''), plain: '', width: 0, ansi };
    }
}

export function visualWidth(str: string): number {
    let width = 0;
    for (const cell of styledCells(str)) width += cell.width;
    return width;
}

export function clipTextToCols(str: string, maxCols: number): string {
    if (!(maxCols > 0)) return '';
    let out = '';
    let width = 0;
    let sawAnsi = false;
    for (const cell of styledCells(str)) {
        if (width + cell.width > maxCols) break;
        out += cell.text;
        width += cell.width;
        sawAnsi ||= cell.ansi.length > 0;
    }
    return sawAnsi ? out + RESET : out;
}

function updateActiveSgr(active: string, seq: string): string {
    if (!seq.endsWith('m')) return active;
    return seq === RESET || seq.length > MAX_SGR_CARRY ? '' : seq;
}

export function wrapTextToCols(str: string, maxCols: number): string[] {
    const cols = Number.isFinite(maxCols) ? Math.max(1, Math.floor(maxCols)) : 1;
    const rows: string[] = [];
    for (const logicalLine of str.split('\n')) {
        if (!logicalLine) { rows.push(''); continue; }
        let out = '';
        let width = 0;
        let activeSgr = '';
        let sawAnsi = false;
        const push = () => {
            rows.push(sawAnsi && !out.endsWith(RESET) ? out + RESET : out);
            out = activeSgr;
            width = 0;
            sawAnsi = Boolean(activeSgr);
        };
        for (const cell of styledCells(logicalLine)) {
            const oversized = cell.width > cols;
            const size = oversized ? 1 : cell.width;
            if (width > 0 && width + size > cols) push();
            out += oversized ? cell.ansi.join('') + '?' : cell.text;
            width += size;
            for (const ansi of cell.ansi) activeSgr = updateActiveSgr(activeSgr, ansi);
            sawAnsi ||= cell.ansi.length > 0;
        }
        push();
    }
    return rows.length ? rows : [''];
}

interface ComposerLineLayout { rows: string[]; cursor: { row: number; col: number }; totalRows: number; }

function layoutComposerLines(displayText: string, cursorOffset: number, cols: number,
    prefix: { first: string; continuation: string; firstWidth: number; continuationWidth: number }): ComposerLineLayout {
    const safeCols = Math.max(1, cols);
    const graphemes = toGraphemes(displayText);
    const cursor = Math.max(0, Math.min(cursorOffset, graphemes.length));
    const rows = [prefix.first];
    let row = 0;
    let col = prefix.firstWidth;
    let cursorRow = 0;
    let cursorCol = prefix.firstWidth;
    for (let i = 0; i <= graphemes.length; i++) {
        const text = graphemes[i];
        const newline = text === '\n' || text === '\r\n' || text === '\r';
        const fitted = text === undefined || newline ? { text: '', width: 0 } : fitCellGrapheme(text, safeCols);
        if (fitted.width > 0 && col > 0 && col + fitted.width > safeCols) { rows.push(''); row++; col = 0; }
        if (i === cursor) { cursorRow = row; cursorCol = col; }
        if (text === undefined) break;
        if (newline) { rows.push(prefix.continuation); row++; col = prefix.continuationWidth; }
        else { rows[row] += fitted.text; col += fitted.width; }
    }
    return { rows, cursor: { row: cursorRow, col: cursorCol }, totalRows: rows.length };
}

/** The classic writer emits these exact rows instead of relying on scalar autowrap. */
export function layoutComposerText(displayText: string, cursorOffset: number, cols: number,
    firstPrefix: string, continuationPrefix: string): ComposerLineLayout {
    return layoutComposerLines(displayText, cursorOffset, cols, { first: firstPrefix, continuation: continuationPrefix,
        firstWidth: visualWidth(firstPrefix), continuationWidth: visualWidth(continuationPrefix) });
}

/** Cursor offsets are source grapheme indices, independent of display fallback. */
export function cursorScreenPos(displayText: string, cursorOffset: number, firstPrefixWidth: number,
    contPrefixWidth: number, cols: number): { row: number; col: number; totalRows: number } {
    const layout = layoutComposerLines(displayText, cursorOffset, cols,
        { first: '', continuation: '', firstWidth: firstPrefixWidth, continuationWidth: contPrefixWidth });
    return { ...layout.cursor, totalRows: layout.totalRows };
}
