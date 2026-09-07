// Leading YAML frontmatter parsing, shared by notes and the wiki.
//
// This lives here rather than under manager because core cannot import from there, and
// the wiki scanner needs the same parser the notes vault uses. Only the parsing half
// moved: normalizing the result into titles, aliases and tags is a notes concern and
// stayed behind, while the wiki reads the same object through its own ontology rules.
//
// It takes text, not a path. That is deliberate — a parser that cannot open a file cannot
// run ahead of the reader whose job is to open files safely.

import { parseDocument } from 'yaml';

export type ParsedNoteFrontmatter = {
    data: Record<string, unknown>;
    bodyStartOffset: number;
    error?: string;
};

function lineEnd(source: string, start: number): number {
    const next = source.indexOf('\n', start);
    return next === -1 ? source.length : next;
}

function nextLineStart(source: string, end: number): number {
    return end < source.length && source[end] === '\n' ? end + 1 : end;
}

function lineText(source: string, start: number, end: number): string {
    const text = source.slice(start, end);
    return text.endsWith('\r') ? text.slice(0, -1) : text;
}

export function parseLeadingFrontmatter(source: string): ParsedNoteFrontmatter {
    const start = source.startsWith('\ufeff') ? 1 : 0;
    const firstEnd = lineEnd(source, start);
    if (lineText(source, start, firstEnd) !== '---') {
        return { data: {}, bodyStartOffset: 0 };
    }

    const contentStart = nextLineStart(source, firstEnd);
    let cursor = contentStart;
    while (cursor < source.length) {
        const end = lineEnd(source, cursor);
        if (lineText(source, cursor, end) === '---') {
            const yamlSource = source.slice(contentStart, cursor);
            const bodyStartOffset = nextLineStart(source, end);
            try {
                const document = parseDocument(yamlSource, { prettyErrors: false });
                const firstError = document.errors[0];
                if (firstError) {
                    return { data: {}, bodyStartOffset, error: firstError.message };
                }
                const value = document.toJS() as unknown;
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    return { data: {}, bodyStartOffset };
                }
                return { data: value as Record<string, unknown>, bodyStartOffset };
            } catch (error) {
                return {
                    data: {},
                    bodyStartOffset,
                    error: error instanceof Error ? error.message : 'frontmatter parse failed',
                };
            }
        }
        cursor = nextLineStart(source, end);
    }

    return { data: {}, bodyStartOffset: 0 };
}
