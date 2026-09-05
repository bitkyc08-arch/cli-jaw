import { FULLTEXT_MAX_CHARS } from '../../events/fulltext-bound.js';
import { acpRecord } from './session.js';

const MAX_CONTENT_ITEMS = 4096;

function contentRecord(value: unknown): Record<string, unknown> {
    try {
        const record = acpRecord(value);
        if (typeof record['type'] !== 'string' || !record['type']) throw new Error();
        return record;
    } catch {
        throw new Error('acp_invalid_content');
    }
}

/** Extract flat text blocks without inspecting unsupported payloads. */
export function acpText(value: unknown): { text: string | null; unsupported: boolean } {
    if (value === null || value === undefined) return { text: null, unsupported: false };
    const items: unknown[] = Array.isArray(value) ? value : [value];
    const count = items.length;
    if (count > MAX_CONTENT_ITEMS) throw new Error('acp_content_limit');
    const parts: string[] = [];
    let length = 0;
    let unsupported = false;
    for (let index = 0; index < count; index++) {
        let block = contentRecord(items[index]);
        if (block['type'] === 'content') {
            block = contentRecord(block['content']);
            // ToolCallContent wraps one content block, never another wrapper or array.
            if (block['type'] === 'content') throw new Error('acp_invalid_content');
        }
        if (block['type'] !== 'text') {
            unsupported = true;
            continue;
        }
        const text = block['text'];
        if (typeof text !== 'string') throw new Error('acp_invalid_content');
        if (text.length > FULLTEXT_MAX_CHARS - length) throw new Error('acp_content_limit');
        length += text.length;
        parts.push(text);
    }
    return { text: parts.length ? parts.join('') : null, unsupported };
}

/** Preserve the whole snapshot; generic RuntimeProjection owns redaction and clipping. */
export function acpSnapshot(value: unknown): string {
    let text: string | undefined;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        throw new Error('acp_invalid_content');
    }
    if (text === undefined) throw new Error('acp_invalid_content');
    if (text.length > FULLTEXT_MAX_CHARS) throw new Error('acp_content_limit');
    return text;
}
