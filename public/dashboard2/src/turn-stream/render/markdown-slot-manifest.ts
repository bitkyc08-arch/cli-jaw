import { contentHash } from './render-cache.js';
import { marked } from 'marked';

export type MarkdownSlot =
    | { id: string; kind: 'code'; code: string; language: string; openFence: boolean }
    | { id: string; kind: 'math'; tex: string; displayMode: boolean; ordinal: number }
    | { id: string; kind: 'mermaid'; source: string }
    | { id: string; kind: 'diff'; source: string }
    | { id: string; kind: 'image'; src: string; alt: string; title?: string };
export interface ExtractedMarkdownSlots { source: string; slots: readonly MarkdownSlot[] }

function placeholder(id: string, block: boolean): string {
    return block ? `\n<div data-render-slot="${id}"></div>\n` : `<span data-render-slot="${id}"></span>`;
}

const UNIFIED_DIFF_FILE_PAIR = /^---\s+.+\n\+\+\+\s+.+$/m;
const UNIFIED_DIFF_HUNK = /^@@\s+-.+\s+\+.+\s+@@/m;

export function hasUnifiedDiffSignature(source: string): boolean {
    return UNIFIED_DIFF_FILE_PAIR.test(source.replace(/\r\n/g, '\n')) && UNIFIED_DIFF_HUNK.test(source);
}

function wrapMarkdownTables(source: string): string {
    return source.replace(/(?:^|\n)((?:\|?.+\|.+\n)\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?(?:\n\|?.+\|.+)*)/g, (whole, table: string) => {
        const rendered = marked.parse(table, { async: false }).trim();
        if (!rendered.startsWith('<table>')) return whole;
        const prefix = whole.startsWith('\n') ? '\n' : '';
        return `${prefix}<div class="d2-table-wrapper" tabindex="0">${rendered}</div>`;
    });
}

export function extractMarkdownSlots(source: string, nonce = contentHash(source), finalized = true): ExtractedMarkdownSlots {
    const slots: MarkdownSlot[] = [];
    let ordinal = 0;
    let processed = source.replace(/```([^\n`]*)\n([\s\S]*?)(```|$)/g, (whole, info: string, code: string, close: string) => {
        const openFence = close !== '```';
        if (!finalized && openFence) return whole;
        const language = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        const kind = language === 'mermaid' ? 'mermaid' : language === 'diff' || (!language && hasUnifiedDiffSignature(code)) ? 'diff' : 'code';
        const id = `${nonce}-${kind}-${slots.length}`;
        if (kind === 'mermaid') slots.push(Object.freeze({ id, kind, source: code }));
        else if (kind === 'diff') slots.push(Object.freeze({ id, kind, source: code }));
        else slots.push(Object.freeze({ id, kind, code, language, openFence }));
        return placeholder(id, true);
    });
    const preserved: string[] = [];
    processed = processed.replace(/`[^`]+`/g, value => `\u0000C${preserved.push(value) - 1}\u0000`);
    processed = processed.replace(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g,
        (_whole, alt: string, bracketSrc: string | undefined, plainSrc: string | undefined, doubleTitle: string | undefined, singleTitle: string | undefined) => {
            const src = bracketSrc ?? plainSrc ?? '';
            const title = doubleTitle ?? singleTitle;
            const id = `${nonce}-image-${slots.length}`;
            slots.push(Object.freeze({ id, kind: 'image', src, alt, ...(title === undefined ? {} : { title }) }));
            return placeholder(id, false);
        });
    const addMath = (tex: string, displayMode: boolean): string => {
        const id = `${nonce}-math-${ordinal}`;
        slots.push(Object.freeze({ id, kind: 'math', tex: tex.trim(), displayMode, ordinal }));
        ordinal += 1;
        return placeholder(id, displayMode);
    };
    processed = processed
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => addMath(tex, true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => addMath(tex, true))
        .replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (_, tex: string) => addMath(tex, false))
        .replace(/\\\((.+?)\\\)/g, (_, tex: string) => addMath(tex, false))
        .replace(/\u0000C(\d+)\u0000/g, (_, index: string) => preserved[Number(index)] ?? '');
    processed = wrapMarkdownTables(processed);
    return Object.freeze({ source: processed, slots: Object.freeze(slots) });
}
