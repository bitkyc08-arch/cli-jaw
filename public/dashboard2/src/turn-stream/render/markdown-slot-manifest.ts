import { contentHash } from './render-cache.js';
import { marked } from 'marked';

export type MarkdownSlot =
    | { id: string; kind: 'code'; code: string; language: string; openFence: boolean }
    | { id: string; kind: 'math'; tex: string; displayMode: boolean; ordinal: number }
    | { id: string; kind: 'mermaid'; source: string }
    | { id: string; kind: 'diff'; source: string }
    | { id: string; kind: 'image'; src: string; alt: string; title?: string }
    | { id: string; kind: 'structured'; fenceKind: 'elicitation' | 'choice-buttons' | 'search-results' | 'compose-block' | 'dataframe' | 'chart-json'; rawSpec: string; ordinal: number }
    | { id: string; kind: 'widget'; widget: { storage: 'inline'; source: string; capabilities: ['interactive'] } | { storage: 'file'; widgetId: string }; ordinal: number };
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
    const structuredKinds = new Set(['elicitation', 'choice-buttons', 'search-results', 'compose-block', 'dataframe', 'chart-json']);
    const normalized = source.replace(/^([ \t]{0,3})(?:[-*+]|\d+[.)])[ \t]+(`{3,}|~{3,})([^\n]*)$/gm, '$1$2$3');
    let processed = normalized.replace(/^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:^\1\2[ \t]*$|$(?![\s\S]))/gm, (whole, _indent: string, fence: string, info: string, code: string) => {
        const closed = new RegExp(`^${fence[0]}{${fence.length},}[ \\t]*$`, 'm').test(whole.slice(whole.indexOf('\n') + 1));
        const openFence = !closed;
        if (!finalized && openFence) return whole;
        const language = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (!finalized && (structuredKinds.has(language) || language === 'diagram-html' || language === 'diagram-file')) return whole;
        const kind = language === 'mermaid' ? 'mermaid' : language === 'diff' || (!language && hasUnifiedDiffSignature(code)) ? 'diff' : structuredKinds.has(language) ? 'structured' : language === 'diagram-html' || language === 'diagram-file' ? 'widget' : 'code';
        const id = `${nonce}-${kind}-${slots.length}`;
        if (kind === 'mermaid') slots.push(Object.freeze({ id, kind, source: code }));
        else if (kind === 'diff') slots.push(Object.freeze({ id, kind, source: code }));
        else if (kind === 'structured') slots.push(Object.freeze({ id, kind, fenceKind: language as Extract<MarkdownSlot, { kind: 'structured' }>['fenceKind'], rawSpec: code, ordinal: ordinal++ }));
        else if (kind === 'widget') {
            const widget: Extract<MarkdownSlot, { kind: 'widget' }>['widget'] = language === 'diagram-file'
                ? { storage: 'file', widgetId: code.trim() }
                : { storage: 'inline', source: code, capabilities: ['interactive'] };
            slots.push(Object.freeze({ id, kind, widget, ordinal: ordinal++ }));
        }
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
