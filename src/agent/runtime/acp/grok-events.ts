import type { RuntimeEventBody } from '../../../shared/runtime-contract.js';
import { acpRecord } from './session.js';

type Usage = Extract<RuntimeEventBody, { kind: 'usage' }>;

/** Optional original-response telemetry; malformed counters cannot invalidate a final answer. */
export function grokUsage(result: Record<string, unknown>): Usage | null {
    if (result['_meta'] === undefined || result['_meta'] === null) return null;
    let raw: Record<string, unknown>;
    try {
        const meta = acpRecord(result['_meta']);
        if (meta['usage'] === undefined || meta['usage'] === null) return null;
        raw = acpRecord(meta['usage']);
    } catch { return null; }
    const event: Usage = { kind: 'usage' };
    const fields = { inputTokens: 'inputTokens', outputTokens: 'outputTokens', cachedReadTokens: 'cachedTokens' } as const;
    for (const [source, target] of Object.entries(fields)) {
        const value = raw[source];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
        event[target] = value;
    }
    return Object.keys(event).length > 1 ? event : null;
}
