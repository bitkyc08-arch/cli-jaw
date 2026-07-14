import { contentHash } from './render-cache.js';

export type MarkdownSlot =
    | { id: string; kind: 'code'; code: string; language: string; openFence: boolean }
    | { id: string; kind: 'math'; tex: string; displayMode: boolean; ordinal: number };
export interface ExtractedMarkdownSlots { source: string; slots: readonly MarkdownSlot[] }

function placeholder(id: string, block: boolean): string {
    return block ? `\n<div data-render-slot="${id}"></div>\n` : `<span data-render-slot="${id}"></span>`;
}
export function extractMarkdownSlots(source: string, nonce = contentHash(source), finalized = true): ExtractedMarkdownSlots {
    const slots: MarkdownSlot[] = [];
    let ordinal = 0;
    let processed = source.replace(/```([^\n`]*)\n([\s\S]*?)(```|$)/g, (whole, info: string, code: string, close: string) => {
        const openFence = close !== '```';
        if (!finalized && openFence) return whole;
        const id = `${nonce}-code-${slots.length}`;
        slots.push(Object.freeze({ id, kind: 'code', code, language: info.trim().split(/\s+/)[0] ?? '', openFence }));
        return placeholder(id, true);
    });
    const preserved: string[] = [];
    processed = processed.replace(/`[^`]+`/g, value => `\u0000C${preserved.push(value) - 1}\u0000`);
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
    return Object.freeze({ source: processed, slots: Object.freeze(slots) });
}
