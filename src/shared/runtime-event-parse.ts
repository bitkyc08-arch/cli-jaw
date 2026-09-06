import type { RuntimeEvent, RuntimeEventIdentity, RuntimeRequestView } from './runtime-contract.js';

const record = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 240;
const text = (x: unknown): x is string => typeof x === 'string' && x.length <= 200_000;
const status = (x: unknown): x is 'running' | 'done' | 'error' | 'stopped' =>
    x === 'running' || x === 'done' || x === 'error' || x === 'stopped';

export function parseRuntimeRequestView(x: unknown): RuntimeRequestView | null {
    if (!record(x) || typeof x['title'] !== 'string' || x['title'].length > 500 ||
        !Array.isArray(x['fields']) || x['fields'].length > 8) return null;
    const fields: RuntimeRequestView['fields'] = [];
    const fieldIds = new Set<string>();
    for (const f of x['fields']) {
        if (!record(f) || !id(f['id']) || typeof f['label'] !== 'string' || f['label'].length > 500 ||
            !Array.isArray(f['options']) || f['options'].length > 20 ||
            typeof f['multiSelect'] !== 'boolean' || typeof f['allowFreeform'] !== 'boolean') return null;
        if (fieldIds.has(f['id'])) return null;
        fieldIds.add(f['id']);
        const options: Array<{ id: string; label: string }> = [];
        const optionIds = new Set<string>();
        for (const option of f['options']) {
            if (!record(option) || !id(option['id']) || typeof option['label'] !== 'string' ||
                option['label'].length > 500) return null;
            if (optionIds.has(option['id'])) return null;
            optionIds.add(option['id']);
            options.push({ id: option['id'], label: option['label'] });
        }
        fields.push({ id: f['id'], label: f['label'], options,
            multiSelect: f['multiSelect'], allowFreeform: f['allowFreeform'] });
    }
    return { title: x['title'], fields };
}

export function parseRuntimeEvent(value: unknown): RuntimeEvent | null {
    if (!record(value) || value['version'] !== 1 || !id(value['runId']) ||
        !id(value['sessionId']) || !id(value['scope']) || !id(value['turnId']) ||
        !Number.isSafeInteger(value['seq']) || Number(value['seq']) <= 0) return null;
    const base: RuntimeEventIdentity = {
        version: 1, runId: value['runId'], sessionId: value['sessionId'],
        scope: value['scope'], turnId: value['turnId'], seq: Number(value['seq']),
    };
    if (value['parentItemId'] !== undefined) {
        if (!id(value['parentItemId'])) return null;
        base.parentItemId = value['parentItemId'];
    }
    const kind = value['kind'];
    if (kind === 'turn-start' && id(value['provider'])) return { ...base, kind, provider: value['provider'] };
    if ((kind === 'message' || kind === 'reasoning') && id(value['itemId']) && text(value['text']) &&
        (value['operation'] === 'append' || value['operation'] === 'replace')) {
        const part = { ...base, itemId: value['itemId'], text: value['text'], operation: value['operation'] } as const;
        if (kind === 'reasoning') return { ...part, kind };
        const phase = value['phase'];
        return phase === 'commentary' || phase === 'final' || phase === 'unknown'
            ? { ...part, kind, phase } : null;
    }
    if (kind === 'tool' && id(value['itemId']) && id(value['name']) && status(value['status'])) {
        for (const key of ['input', 'output', 'detail']) {
            if (value[key] !== undefined && !text(value[key])) return null;
        }
        return { ...base, kind, itemId: value['itemId'], name: value['name'], status: value['status'],
            ...(typeof value['input'] === 'string' ? { input: value['input'] } : {}),
            ...(typeof value['output'] === 'string' ? { output: value['output'] } : {}),
            ...(typeof value['detail'] === 'string' ? { detail: value['detail'] } : {}) };
    }
    if (kind === 'request' && id(value['requestId']) &&
        (value['requestType'] === 'approval' || value['requestType'] === 'question')) {
        const view = parseRuntimeRequestView(value['view']);
        return view ? { ...base, kind, requestId: value['requestId'], requestType: value['requestType'], view } : null;
    }
    if (kind === 'request-settled' && id(value['requestId'])) return { ...base, kind, requestId: value['requestId'] };
    if (kind === 'turn-end' && status(value['status']) && value['status'] !== 'running' &&
        (value['finalText'] === null || text(value['finalText']))) {
        if (value['error'] !== undefined && !text(value['error'])) return null;
        return { ...base, kind, status: value['status'], finalText: value['finalText'],
            ...(typeof value['error'] === 'string' ? { error: value['error'] } : {}) };
    }
    if (kind === 'usage') {
        const usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } = {};
        for (const key of ['inputTokens', 'outputTokens', 'cachedTokens'] as const) {
            const count = value[key];
            if (count === undefined) continue;
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
            usage[key] = count;
        }
        return { ...base, kind, ...usage };
    }
    return null;
}
