import { stripUndefined } from '../../core/strip-undefined.js';
import type { NoteIndexWarning } from '../types.js';
// The parser moved to core so the wiki scanner can reach it; core cannot import from
// manager, and two parsers over the same frontmatter would be two answers to one
// question. Re-exported here so existing callers keep their import site.
import { parseLeadingFrontmatter, type ParsedNoteFrontmatter } from '../../notes/frontmatter.js';

export { parseLeadingFrontmatter };
export type { ParsedNoteFrontmatter };

export type NormalizedFrontmatter = {
    title?: string;
    aliases: string[];
    tags: string[];
    created?: string;
    warnings: NoteIndexWarning[];
};

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
