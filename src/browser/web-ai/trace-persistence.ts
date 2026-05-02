import { MAX_TRACE_BYTES, MAX_TRACE_STEPS } from './constants.js';
import { getSession, updateSessionStatus } from './session.js';
import type { WebAiSessionRecord } from './types.js';

const REDACTION_PATTERNS = [
    /sk-[a-zA-Z0-9]{20,}/g,
    /sk-proj-[a-zA-Z0-9_-]{20,}/g,
    /Bearer\s+[a-zA-Z0-9._-]+/gi,
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
];

export type TracePersistableValue =
    | string
    | number
    | boolean
    | null
    | TracePersistableValue[]
    | { [key: string]: TracePersistableValue | undefined };

export interface TraceSessionRecord extends WebAiSessionRecord {
    trace?: TracePersistableValue[];
}

export function redactSensitive<T>(value: T): T {
    if (typeof value === 'string') {
        let redacted: string = value;
        for (const pattern of REDACTION_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]');
        return redacted as unknown as T;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactSensitive(entry)) as T;
    }
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) result[key] = redactSensitive(child);
        return result as T;
    }
    return value;
}

export function appendTraceToSession(sessionId: string, steps: TracePersistableValue[]): void {
    if (!steps?.length) return;
    const redacted = redactSensitive(steps);
    const session = getSession(sessionId) as TraceSessionRecord | null;
    if (!session) return;

    const trace = session.trace || [];
    trace.push(...redacted);
    while (trace.length > MAX_TRACE_STEPS) trace.shift();
    while (JSON.stringify(trace).length > MAX_TRACE_BYTES && trace.length > 0) trace.shift();

    session.trace = trace;
    updateSessionStatus(sessionId, session.status);
}
