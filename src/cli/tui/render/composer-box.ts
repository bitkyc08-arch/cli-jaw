import { toGraphemes } from '../text-buffer.js';
import { clipTextToCols, visualWidth } from '../renderers.js';
import { fitCellGrapheme } from '../cell-width.js';

export interface ComposerBorderChars {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
}

export interface ComposerBoxTheme {
    dimCode: string;
    resetCode: string;
    accentCode: string;
    boldCode: string;
    border: ComposerBorderChars;
    promptGlyph?: string;
    placeholder?: string;
    textCode?: string;
    placeholderCode?: string;
}

export interface ComposerBoxLayout {
    rows: string[];
    cursor: { row: number; col: number };
    visualRowCount: number;
    visibleRowStart: number;
    textWidth: number;
    prefixWidth: number;
}

interface WrappedComposerText {
    rows: string[];
    cursor: { row: number; col: number };
}

const DEFAULT_PROMPT_GLYPH = '>';
const DEFAULT_PLACEHOLDER = 'Type your message...';
const PREFIX_WIDTH = 4; // │ + space + prompt glyph + space

function wrapComposerText(displayText: string, cursorOffset: number, textWidth: number): WrappedComposerText {
    const width = Math.max(1, textWidth);
    const graphemes = toGraphemes(displayText);
    const cursor = Math.max(0, Math.min(cursorOffset, graphemes.length));
    const rows: string[] = [''];
    let row = 0;
    let col = 0;
    let cursorRow = 0;
    let cursorCol = 0;

    for (let i = 0; i <= graphemes.length; i += 1) {
        const ch = graphemes[i];
        const newline = ch === '\n' || ch === '\r\n' || ch === '\r';
        const fitted = ch === undefined || newline ? { text: '', width: 0 } : fitCellGrapheme(ch, width);
        if (fitted.width > 0 && col > 0 && col + fitted.width > width) {
            row += 1;
            rows[row] = '';
            col = 0;
        }
        if (i === cursor) {
            cursorRow = row;
            cursorCol = col;
        }
        if (i === graphemes.length) break;
        if (newline) {
            row += 1;
            rows[row] = '';
            col = 0;
            continue;
        }

        rows[row] = `${rows[row] ?? ''}${fitted.text}`;
        col = Math.min(width, col + fitted.width);
    }

    return { rows, cursor: { row: cursorRow, col: cursorCol } };
}

function visibleWindow(totalRows: number, cursorRow: number, maxRows: number): { start: number; end: number } {
    const safeMax = Math.max(1, maxRows);
    if (totalRows <= safeMax) return { start: 0, end: totalRows };
    const maxStart = Math.max(0, totalRows - safeMax);
    const start = Math.max(0, Math.min(cursorRow - safeMax + 1, maxStart));
    return { start, end: start + safeMax };
}

function padToCells(text: string, width: number): string {
    return `${text}${' '.repeat(Math.max(0, width - visualWidth(text)))}`;
}

function formatInputRow(text: string, options: ComposerBoxTheme, textWidth: number, isFirst: boolean, placeholder = false): string {
    const border = options.border;
    const promptGlyph = options.promptGlyph ?? DEFAULT_PROMPT_GLYPH;
    const rawPrefix = isFirst
        ? `${options.dimCode}${border.vertical}${options.resetCode} ${options.accentCode}${options.boldCode}${promptGlyph}${options.resetCode} `
        : `${options.dimCode}${border.vertical}${options.resetCode}   `;
    const clippedText = clipTextToCols(text, textWidth);
    const bodyCode = placeholder ? (options.placeholderCode ?? options.dimCode) : (options.textCode ?? '');
    const body = bodyCode ? `${bodyCode}${clippedText}${options.resetCode}` : clippedText;
    const paddedBody = padToCells(body, textWidth);
    return clipTextToCols(`${rawPrefix}${paddedBody}${options.dimCode}${border.vertical}${options.resetCode}`, textWidth + PREFIX_WIDTH + 1);
}

function formatBorderRow(left: string, right: string, horizontal: string, cols: number, dimCode: string, resetCode: string): string {
    const safeCols = Math.max(6, cols);
    return clipTextToCols(`${dimCode}${left}${horizontal.repeat(Math.max(0, safeCols - 2))}${right}${resetCode}`, safeCols);
}

export function composerTextWidth(cols: number): number {
    return Math.max(1, Math.max(6, cols) - PREFIX_WIDTH - 1);
}

export function measureComposerVisualRows(displayText: string, cursorOffset = displayText.length, cols = process.stdout.columns || 80): number {
    const width = composerTextWidth(cols);
    return Math.max(1, wrapComposerText(displayText, cursorOffset, width).rows.length);
}

export function composeComposerBox(
    displayText: string,
    cursorOffset: number,
    cols: number,
    inputRows: number,
    options: ComposerBoxTheme,
): ComposerBoxLayout {
    const safeCols = Math.max(6, cols);
    const textWidth = composerTextWidth(safeCols);
    const hasInput = displayText.length > 0;
    const wrapped = wrapComposerText(displayText, cursorOffset, textWidth);
    const window = visibleWindow(wrapped.rows.length, wrapped.cursor.row, Math.max(1, inputRows));
    const visible = wrapped.rows.slice(window.start, window.end);
    while (visible.length < Math.max(1, inputRows)) visible.push('');

    const rows: string[] = [
        formatBorderRow(options.border.topLeft, options.border.topRight, options.border.horizontal, safeCols, options.dimCode, options.resetCode),
    ];

    if (!hasInput) {
        const placeholder = clipTextToCols(options.placeholder ?? DEFAULT_PLACEHOLDER, textWidth);
        rows.push(formatInputRow(placeholder, options, textWidth, true, true));
        for (let i = 1; i < Math.max(1, inputRows); i += 1) {
            rows.push(formatInputRow('', options, textWidth, false));
        }
    } else {
        for (let i = 0; i < visible.length; i += 1) {
            rows.push(formatInputRow(visible[i] ?? '', options, textWidth, i === 0 && window.start === 0));
        }
    }

    rows.push(formatBorderRow(options.border.bottomLeft, options.border.bottomRight, options.border.horizontal, safeCols, options.dimCode, options.resetCode));

    const cursorRow = Math.max(0, Math.min(Math.max(1, inputRows) - 1, wrapped.cursor.row - window.start));
    const cursorCol = Math.max(PREFIX_WIDTH, Math.min(PREFIX_WIDTH + textWidth, PREFIX_WIDTH + wrapped.cursor.col));

    return {
        rows,
        cursor: { row: cursorRow, col: cursorCol },
        visualRowCount: wrapped.rows.length,
        visibleRowStart: window.start,
        textWidth,
        prefixWidth: PREFIX_WIDTH,
    };
}
