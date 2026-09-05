import type { RuntimeEvent, RuntimeEventBody, RuntimeEventIdentity, RuntimeRequestView } from '../shared/runtime-contract.js';
import { parseRuntimeEvent } from '../shared/runtime-event-parse.js';
import { redactTraceValue, stringifyTraceValue } from './redact.js';

export type RuntimeBodyRecord = {
    turnId: string;
    parentItemId?: string;
    fields: Array<[string, unknown]>;
};
export const RUNTIME_BODY_BYTES = 32_768;
const allowed: Record<string, readonly string[]> = {
    'turn-start': ['kind', 'provider'],
    message: ['kind', 'itemId', 'phase', 'text', 'operation'],
    reasoning: ['kind', 'itemId', 'text', 'operation'],
    tool: ['kind', 'itemId', 'name', 'status', 'input', 'output', 'detail'],
    request: ['kind', 'requestId', 'requestType', 'view'],
    'request-settled': ['kind', 'requestId'],
    usage: ['kind', 'inputTokens', 'outputTokens', 'cachedTokens'],
    'turn-end': ['kind', 'status', 'finalText', 'error'],
};
export function redactRuntimeContent(value: string, options: { structured?: boolean } = {}): string {
    let next = value;
    const trimmed = value.trimStart();
    const fenced = trimmed.startsWith('```json');
    const structured = options.structured === true;
    const fencedBody = fenced ? /^```json\s*\n([\s\S]*?)\n```\s*$/.exec(trimmed)?.[1] : undefined;
    if (structured && fenced && fencedBody === undefined) return '[structured content withheld]';
    try {
        const parsed: unknown = JSON.parse(fencedBody ?? value);
        if (parsed !== null && typeof parsed === 'object') {
            const redacted = redactTraceValue(parsed);
            // Compare normalized VALUES only to decide whether redaction changed
            // anything; retain the original bytes when it did not.
            // Inspect original key tokens too: JSON.parse keeps only the last
            // duplicate key and could otherwise hide an earlier secret value.
            let sensitiveKey = false;
            for (const match of (fencedBody ?? value).matchAll(/"(?:\\.|[^"\\])*"\s*:?/g)) {
                const token = match[0].trimEnd();
                if (!token.endsWith(':')) continue;
                const key: unknown = JSON.parse(token.slice(0, -1).trimEnd());
                if (typeof key !== 'string') continue;
                const probe = { [key]: '__runtime_redaction_probe__' };
                if (JSON.stringify(probe) !== JSON.stringify(redactTraceValue(probe))) sensitiveKey = true;
            }
            if (sensitiveKey || JSON.stringify(parsed) !== JSON.stringify(redacted)) next = JSON.stringify(redacted);
        }
    } catch {
        // Never let a clipped/incomplete object bypass structured key masking.
        if (structured) return '[structured content withheld]';
    }
    return stringifyTraceValue(next);
}
export function sanitizeRuntimeRequestView(value: unknown): RuntimeRequestView | null {
    const object = (x: unknown): x is Record<string, unknown> =>
        x !== null && typeof x === 'object' && !Array.isArray(x);
    const id = (x: unknown): x is string =>
        typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,239}$/.test(x);
    const label = (x: string): string => {
        const safe = redactRuntimeContent(x);
        if (safe.length <= 500) return safe;
        let end = 499;
        const code = safe.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--;
        // Redaction already ran on the full label; clipping cannot restore
        // secrets. Default prose mode keeps Markdown/commands readable.
        return redactRuntimeContent(safe.slice(0, end) + '…');
    };
    if (!object(value) || typeof value['title'] !== 'string' || !Array.isArray(value['fields'])
        || value['fields'].length > 8) return null;
    const fields: RuntimeRequestView['fields'] = [];
    const seen = new Set<string>();
    for (const field of value['fields']) {
        if (!object(field) || !id(field['id']) || seen.has(field['id'])
            || typeof field['label'] !== 'string' || !Array.isArray(field['options'])
            || field['options'].length > 20 || typeof field['multiSelect'] !== 'boolean'
            || typeof field['allowFreeform'] !== 'boolean') return null;
        seen.add(field['id']);
        const options: Array<{ id: string; label: string }> = [];
        const optionIds = new Set<string>();
        for (const option of field['options']) {
            if (!object(option) || !id(option['id']) || optionIds.has(option['id'])
                || typeof option['label'] !== 'string') return null;
            optionIds.add(option['id']);
            options.push({ id: option['id'], label: label(option['label']) });
        }
        fields.push({ id: field['id'], label: label(field['label']), options,
            multiSelect: field['multiSelect'], allowFreeform: field['allowFreeform'] });
    }
    return { title: label(value['title']), fields };
}
function bodyOf(event: RuntimeEvent): RuntimeEventBody {
    const { version, runId, sessionId, scope, turnId, seq, parentItemId, ...body } = event;
    return body;
}
export function encodeRuntimeBody(identity: RuntimeEventIdentity, input: RuntimeEventBody): {
    raw: RuntimeBodyRecord; body: RuntimeEventBody;
} {
    // Optional ownership must also overwrite body fields when it is absent.
    const parsed = parseRuntimeEvent({ ...input, ...identity, parentItemId: identity.parentItemId });
    if (!parsed) throw new TypeError('invalid_runtime_event');
    const body = bodyOf(parsed);
    switch (body.kind) {
        case 'message': case 'reasoning': body.text = redactRuntimeContent(body.text); break;
        case 'tool':
            body.name = redactRuntimeContent(body.name);
            if (body.input !== undefined) body.input = redactRuntimeContent(body.input);
            if (body.output !== undefined) body.output = redactRuntimeContent(body.output);
            if (body.detail !== undefined) body.detail = redactRuntimeContent(body.detail);
            break;
        case 'turn-end':
            if (body.finalText !== null) body.finalText = redactRuntimeContent(body.finalText);
            if (body.error !== undefined) body.error = redactRuntimeContent(body.error);
            break;
        case 'request': {
            const view = sanitizeRuntimeRequestView(body.view);
            if (!view) throw new TypeError('invalid_runtime_request_view');
            body.view = view;
            break;
        }
    }
    if (!parseRuntimeEvent({ ...body, ...identity })) throw new TypeError('invalid_redacted_runtime_event');
    const raw: RuntimeBodyRecord = { turnId: parsed.turnId,
        ...(parsed.parentItemId === undefined ? {} : { parentItemId: parsed.parentItemId }),
        fields: Object.entries(body) };
    return { raw, body };
}
export function decodeRuntimeBody(raw: unknown, identity: Omit<RuntimeEventIdentity, 'turnId' | 'parentItemId'>,
    eventType: string): RuntimeEvent | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (Object.keys(obj).some(key => !['turnId', 'parentItemId', 'fields'].includes(key))
        || typeof obj['turnId'] !== 'string' || !Array.isArray(obj['fields']) || obj['fields'].length > 8) return null;
    const entries: Array<[string, unknown]> = [];
    const seen = new Set<string>();
    for (const pair of obj['fields']) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || seen.has(pair[0])) return null;
        seen.add(pair[0]); entries.push([pair[0], pair[1]]);
    }
    const kind = entries.find(([key]) => key === 'kind')?.[1];
    if (typeof kind !== 'string' || !Object.hasOwn(allowed, kind) || kind !== eventType) return null;
    if (entries.some(([key]) => !allowed[kind]!.includes(key))) return null;
    return parseRuntimeEvent({ ...Object.fromEntries(entries), ...identity, turnId: obj['turnId'],
        parentItemId: obj['parentItemId'] });
}
