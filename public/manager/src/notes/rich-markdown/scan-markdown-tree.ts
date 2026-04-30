import type { RichMarkdownRange } from './rich-markdown-types';

type ScanOptions = {
    selectionFrom: number;
    selectionTo: number;
    maxWidgets: number;
    maxSnippetBytes: number;
    maxMermaidWidgets: number;
    largeNoteDisableThreshold: number;
};

function intersectsSelection(from: number, to: number, options: ScanOptions): boolean {
    return options.selectionFrom <= to && options.selectionTo >= from;
}

function snippetAllowed(markdown: string, options: ScanOptions): boolean {
    return new TextEncoder().encode(markdown).byteLength <= options.maxSnippetBytes;
}

function pushRange(ranges: RichMarkdownRange[], range: RichMarkdownRange, options: ScanOptions): void {
    if (ranges.length >= options.maxWidgets) return;
    if (intersectsSelection(range.from, range.to, options)) return;
    if (!snippetAllowed(range.markdown, options)) return;
    ranges.push(range);
}

export function scanMarkdownRichRanges(markdown: string, options: ScanOptions): RichMarkdownRange[] {
    if (markdown.length > options.largeNoteDisableThreshold) return [];
    const ranges: RichMarkdownRange[] = [];
    let mermaidCount = 0;

    const fencedPattern = /^```([^\n`]*)\n[\s\S]*?\n```[ \t]*$/gm;
    for (const match of markdown.matchAll(fencedPattern)) {
        if (ranges.length >= options.maxWidgets) break;
        const from = match.index || 0;
        const to = from + match[0].length;
        const language = (match[1] || '').trim().toLowerCase();
        if (language === 'mermaid') {
            if (mermaidCount >= options.maxMermaidWidgets) continue;
            mermaidCount += 1;
        }
        pushRange(ranges, {
            from,
            to,
            kind: language === 'mermaid' ? 'mermaid' : 'code',
            markdown: match[0],
            block: true,
        }, options);
    }

    const blockMathPattern = /^\$\$\n[\s\S]*?\n\$\$[ \t]*$/gm;
    for (const match of markdown.matchAll(blockMathPattern)) {
        if (ranges.length >= options.maxWidgets) break;
        const from = match.index || 0;
        pushRange(ranges, {
            from,
            to: from + match[0].length,
            kind: 'math-block',
            markdown: match[0],
            block: true,
        }, options);
    }

    const inlineMathPattern = /(^|[^$\\])(\$[^$\n]+\$)/g;
    for (const match of markdown.matchAll(inlineMathPattern)) {
        if (ranges.length >= options.maxWidgets) break;
        const prefixLength = match[1].length;
        const from = (match.index || 0) + prefixLength;
        const raw = match[2];
        pushRange(ranges, {
            from,
            to: from + raw.length,
            kind: 'math-inline',
            markdown: raw,
            block: false,
        }, options);
    }

    return ranges.sort((a, b) => a.from - b.from || a.to - b.to);
}

