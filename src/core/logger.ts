// ─── Logger (level-aware console wrapper + ring buffer) ────────────

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env["LOG_LEVEL"] || 'info'] ?? 1;

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogEntry = { ts: string; level: LogLevel; text: string };
export type LogTraceFields = { traceId?: string; spanId?: string; channel?: string };

const LOG_RING_MAX = 200;
const logRing: LogEntry[] = [];

const FORBIDDEN_EVENT_FIELDS = new Set([
    'payload_json', 'payloadJson', 'text', 'token', 'tokens',
    'message', 'raw', 'body', 'content',
]);

let readLogTrace: () => LogTraceFields | undefined = () => undefined;

/** Messaging ALS installs this so `log.event` can stamp a trace without importing messaging. */
export function setLogTraceReader(reader: () => LogTraceFields | undefined): void {
    readLogTrace = reader;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value); // best-effort: circular/BigInt values degrade to toString
    }
}

function jsonSafe(value: unknown): unknown {
    if (value === null) return null;
    const kind = typeof value;
    if (kind === 'string' || kind === 'boolean') return value;
    if (kind === 'number') return Number.isFinite(value) ? value : String(value);
    if (Array.isArray(value)) {
        return value.map(jsonSafe).filter((item) => item !== undefined);
    }
    if (kind === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (FORBIDDEN_EVENT_FIELDS.has(key)) continue;
            const safe = jsonSafe(item);
            if (safe !== undefined) out[key] = safe;
        }
        return out;
    }
    return undefined;
}

function pushRing(level: LogLevel, args: unknown[]): void {
    const text = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ');
    logRing.push({ ts: new Date().toISOString(), level, text });
    while (logRing.length > LOG_RING_MAX) logRing.shift();
}

export function drainLogRing(): LogEntry[] {
    return [...logRing];
}

function writeEvent(name: string, fields: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { event: String(name) };
    const safeFields = jsonSafe(fields);
    if (safeFields && typeof safeFields === 'object' && !Array.isArray(safeFields)) {
        Object.assign(payload, safeFields);
    }
    const trace = readLogTrace();
    if (trace?.traceId) payload['traceId'] = trace.traceId;
    if (trace?.spanId) payload['spanId'] = trace.spanId;
    if (trace?.channel) payload['channel'] = trace.channel;
    const line = JSON.stringify(payload);
    pushRing('info', [line]);
    if (current <= 1) console.log(line);
}

export const log = {
    debug: (...args: unknown[]) => { if (current <= 0) { pushRing('debug', args); console.debug('[debug]', ...args); } },
    info: (...args: unknown[]) => { if (current <= 1) { pushRing('info', args); console.log(...args); } },
    warn: (...args: unknown[]) => { if (current <= 2) { pushRing('warn', args); console.warn(...args); } },
    error: (...args: unknown[]) => { if (current <= 3) { pushRing('error', args); console.error(...args); } },
    event: (name: string, fields: Record<string, unknown> = {}) => { writeEvent(name, fields); },
};

export type StructuredLogEvent = Record<string, unknown> & { event: string; ts: string };

export function recentStructuredLogEvents(limit = 20): StructuredLogEvent[] {
    const out: StructuredLogEvent[] = [];
    for (const entry of drainLogRing()) {
        try {
            const parsed = JSON.parse(entry.text) as Record<string, unknown>;
            if (typeof parsed['event'] !== 'string') continue;
            out.push({ ...parsed, event: parsed['event'], ts: entry.ts });
        } catch {
            // text lines from log.info stay out of the structured view
        }
    }
    return out.slice(-limit);
}
