import { parseDocument } from 'yaml';
import { stripUndefined } from '../../core/strip-undefined.js';
import type { NoteIndexWarning } from '../types.js';

export type ParsedNoteFrontmatter = {
    data: Record<string, unknown>;
    bodyStartOffset: number;
    error?: string;
};

export type NormalizedFrontmatter = {
    title?: string;
    aliases: string[];
    tags: string[];
    created?: string;
    warnings: NoteIndexWarning[];
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

function pushWarning(
    warnings: NoteIndexWarning[],
    path: string,
    key: string,
    message: string,
): void {
    warnings.push({
        code: 'frontmatter_unsupported_value',
        path,
        message: `${key}: ${message}`,
    });
}

function dedupeStable(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function normalizeStringList(
    value: unknown,
    options: {
        path: string;
        key: string;
        warnings: NoteIndexWarning[];
        splitString?: boolean;
        stripHash?: boolean;
    },
): string[] {
    if (value === undefined || value === null) return [];
    const normalize = (item: string): string => {
        const trimmed = item.trim();
        return options.stripHash && trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
    };
    if (typeof value === 'string') {
        const parts = options.splitString ? value.split(/\s+/u) : [value];
        return dedupeStable(parts.map(normalize).filter(Boolean));
    }
    if (Array.isArray(value)) {
        const result: string[] = [];
        for (const item of value) {
            if (typeof item !== 'string') {
                pushWarning(options.warnings, options.path, options.key, 'array values must be strings');
                continue;
            }
            const normalized = normalize(item);
            if (normalized) result.push(normalized);
        }
        return dedupeStable(result);
    }
    pushWarning(options.warnings, options.path, options.key, 'value must be a string or string array');
    return [];
}

export function normalizeFrontmatter(
    path: string,
    data: Record<string, unknown>,
): NormalizedFrontmatter {
    const warnings: NoteIndexWarning[] = [];
    const title = typeof data["title"] === 'string' && data["title"].trim() ? data["title"].trim() : undefined;
    const aliases = dedupeStable([
        ...normalizeStringList(data["aliases"], { path, key: 'aliases', warnings }),
        ...normalizeStringList(data["alias"], { path, key: 'alias', warnings }),
    ]);
    const tags = normalizeStringList(data["tags"], {
        path,
        key: 'tags',
        warnings,
        splitString: true,
        stripHash: true,
    });
    const created = typeof data["created"] === 'string' && data["created"].trim()
        ? data["created"].trim()
        : data["created"] instanceof Date
            ? data["created"].toISOString()
            : undefined;

    if (data["created"] !== undefined && created === undefined) {
        pushWarning(warnings, path, 'created', 'value must be a string or timestamp');
    }

    return stripUndefined({ title, aliases, tags, created, warnings });
}
