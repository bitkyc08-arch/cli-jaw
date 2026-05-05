import { readFileSync } from 'node:fs';

export function normalizeStrictPropertyAccess(source: string): string {
    return unwrapHelperCall(source, 'stripUndefined')
        .replace(/([A-Za-z_$][\w$]*|\]|\))\?\.\[\s*["']([A-Za-z_$][\w$]*)["']\s*\]/g, '$1?.$2')
        .replace(/([A-Za-z_$][\w$]*|\]|\))!\[\s*["']([A-Za-z_$][\w$]*)["']\s*\]/g, '$1!.$2')
        .replace(/([A-Za-z_$][\w$]*|\]|\))\[\s*["']([A-Za-z_$][\w$]*)["']\s*\]/g, '$1.$2');
}

function unwrapHelperCall(source: string, helperName: string): string {
    const token = `${helperName}(`;
    let out = '';
    let cursor = 0;
    while (cursor < source.length) {
        const start = source.indexOf(token, cursor);
        if (start === -1) {
            out += source.slice(cursor);
            break;
        }
        out += source.slice(cursor, start);
        const bodyStart = start + token.length;
        const bodyEnd = findCallEnd(source, bodyStart);
        if (bodyEnd === -1) {
            out += source.slice(start);
            break;
        }
        out += source.slice(bodyStart, bodyEnd);
        cursor = bodyEnd + 1;
    }
    return out;
}

function findCallEnd(source: string, bodyStart: number): number {
    let depth = 1;
    let quote: '"' | "'" | '`' | null = null;
    let escaped = false;
    for (let i = bodyStart; i < source.length; i += 1) {
        const char = source[i];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (depth === 0) return i;
    }
    return -1;
}

export function readSource(path: string, _encoding: BufferEncoding = 'utf8'): string {
    return normalizeStrictPropertyAccess(readFileSync(path, 'utf8'));
}
