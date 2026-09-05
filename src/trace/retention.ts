import { pruneTraceEvents } from './store.js';
export const TRACE_RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;
export type TraceRetentionHandle = { stop(): void; readonly stopped: boolean };

/** Prune once now, then every TRACE_RETENTION_SWEEP_MS until stop() is called.
 *  server.ts owns the only production handle; shutdown(sig) calls stop(). */
export function startTraceRetention(trace?: {
    retentionDays?: number;
    maxRows?: number;
}): TraceRetentionHandle {
    const retentionDays = trace?.retentionDays ?? 7;
    const maxRows = trace?.maxRows ?? 50_000;
    const sweep = () => pruneTraceEvents(retentionDays, maxRows);
    sweep();
    const timer = setInterval(sweep, TRACE_RETENTION_SWEEP_MS);
    timer.unref();
    let stopped = false;
    return {
        stop() { if (stopped) return; stopped = true; clearInterval(timer); },
        get stopped() { return stopped; },
    };
}
