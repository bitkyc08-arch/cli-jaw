import { visualWidth } from './renderers.js';
import { toGraphemes } from './text-buffer.js';

const ESC = 0x1b;
const CSI = 0x9b;
const OSC = 0x9d;
const ST = 0x9c;
const stringControls = new Set([0x90, 0x98, OSC, 0x9e, 0x9f]);
const zeroCell = /[\p{Mark}\p{Default_Ignorable_Code_Point}]/u;
const emojiPresentation = /\p{Emoji_Presentation}/u;
const emoji = /\p{Emoji}/u;
const pictograph = /\p{Extended_Pictographic}/u;

/** Unterminated strings consume the remaining input, including embedded escapes. */
function afterControlString(value: string, start: number, osc: boolean): number {
    for (let pos = start; pos < value.length; pos++) {
        const cp = value.charCodeAt(pos);
        if (cp === ST || (osc && cp === 0x07)) return pos + 1;
        if (cp === ESC && value[pos + 1] === '\\') return pos + 2;
    }
    return value.length;
}

/** Drop parameter/intermediate bytes and their final; a new opener restarts parsing. */
function afterControlSequence(value: string, start: number, csi: boolean): number {
    for (let pos = start; pos < value.length; pos++) {
        const cp = value.charCodeAt(pos);
        if (cp === ESC || (cp >= 0x80 && cp <= 0x9f)) return pos;
        if (cp >= (csi ? 0x40 : 0x30) && cp <= 0x7e) return pos + 1;
        // Malformed non-ASCII sequences stay hidden through the next final or EOF.
    }
    return value.length;
}

/**
 * Display-only transform. Pass the complete accumulated RAW value on every render:
 * sanitizing individual chunks loses unfinished-control context. No cross-call state.
 * Unfinished control tails are withheld until their terminator arrives. BEL ends only
 * OSC; other control strings remain hidden until ST, even with malformed payloads.
 */
export function safeActivityTerminalText(value: string): string {
    const out: string[] = [];
    let pos = 0;
    while (pos < value.length) {
        const cp = value.charCodeAt(pos);
        if (cp === ESC) {
            const next = value.charCodeAt(pos + 1);
            // ESC followed by 0x40..0x5f is the 7-bit representation of C1.
            const c1 = next >= 0x40 && next <= 0x5f ? next + 0x40 : next;
            if (stringControls.has(c1)) pos = afterControlString(value, pos + 2, c1 === OSC);
            else if (c1 === CSI) pos = afterControlSequence(value, pos + 2, true);
            else pos = afterControlSequence(value, pos + 1, false);
            continue;
        }
        if (stringControls.has(cp)) {
            pos = afterControlString(value, pos + 1, cp === OSC);
            continue;
        }
        if (cp === CSI) {
            pos = afterControlSequence(value, pos + 1, true);
            continue;
        }
        if (cp === 9) out.push('    ');
        else if (cp === 10 || cp === 13 || (cp >= 32 && (cp < 127 || cp > 159))) {
            out.push(value[pos]!);
        }
        pos++;
    }
    return out.join('').replace(/\r\n?/g, '\n').replace(/\p{Bidi_Control}/gu, '');
}

/** Activity cell policy: narrow ambiguous characters, whole emoji, NFC Hangul. */
function graphemeCells(grapheme: string): number {
    const normalized = grapheme.normalize('NFC');
    const visible = Array.from(normalized).filter(char => {
        const cp = char.codePointAt(0)!;
        // Hangul medial/final jamo combine with their leading cell, including archaic forms.
        return !zeroCell.test(char) && !(cp >= 0x1160 && cp <= 0x11ff)
            && !(cp >= 0xd7b0 && cp <= 0xd7ff);
    });
    if (visible.length === 0) return 0;
    const textPresentation = normalized.includes('\ufe0e');
    if ((!textPresentation && emojiPresentation.test(normalized))
        || (normalized.includes('\ufe0f') && emoji.test(normalized))
        || /[0-9#*]\ufe0f?\u20e3/u.test(normalized)
        || (normalized.includes('\u200d') && pictograph.test(normalized))) return 2;
    // A cluster occupies its widest base, not a sum of combining or joined bases.
    let width = 0;
    for (const char of visible) {
        const cp = char.codePointAt(0)!;
        const cells = cp >= 0x20000 && cp <= 0x3fffd ? 2 : visualWidth(char);
        width = Math.max(width, cells);
    }
    return width;
}

/** Width of the widest sanitized logical line (newlines do not consume cells). */
export function activityTerminalWidth(value: string): number {
    let widest = 0;
    for (const line of safeActivityTerminalText(value).split('\n')) {
        let width = 0;
        for (const grapheme of toGraphemes(line)) width += graphemeCells(grapheme);
        widest = Math.max(widest, width);
    }
    return widest;
}

/**
 * Sanitize before layout; preserve blank/trailing lines and source graphemes.
 * Columns are floored, with non-finite/non-positive values treated as one column.
 * A two-cell grapheme becomes '?' only when the entire viewport is one cell wide.
 */
export function wrapActivityTerminalText(value: string, columns: number): string[] {
    const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
    const rows: string[] = [];
    for (const line of safeActivityTerminalText(value).split('\n')) {
        let row = '';
        let width = 0;
        for (const grapheme of toGraphemes(line)) {
            const cells = graphemeCells(grapheme);
            const text = cells > cols ? '?' : grapheme;
            const size = cells > cols ? 1 : cells;
            if (width > 0 && width + size > cols) {
                rows.push(row);
                row = '';
                width = 0;
            }
            row += text;
            width += size;
        }
        rows.push(row);
    }
    return rows;
}
