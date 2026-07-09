// ─── Logger (level-aware console wrapper + ring buffer) ────────────

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env["LOG_LEVEL"] || 'info'] ?? 1;

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogEntry = { ts: string; level: LogLevel; text: string };

const LOG_RING_MAX = 200;
const logRing: LogEntry[] = [];

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value); // best-effort: circular/BigInt values degrade to toString
    }
}

function pushRing(level: LogLevel, args: unknown[]): void {
    const text = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ');
    logRing.push({ ts: new Date().toISOString(), level, text });
    while (logRing.length > LOG_RING_MAX) logRing.shift();
}

export function drainLogRing(): LogEntry[] {
    return [...logRing];
}

export const log = {
    debug: (...args: unknown[]) => { if (current <= 0) { pushRing('debug', args); console.debug('[debug]', ...args); } },
    info: (...args: unknown[]) => { if (current <= 1) { pushRing('info', args); console.log(...args); } },
    warn: (...args: unknown[]) => { if (current <= 2) { pushRing('warn', args); console.warn(...args); } },
    error: (...args: unknown[]) => { if (current <= 3) { pushRing('error', args); console.error(...args); } },
};
