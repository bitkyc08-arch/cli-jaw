/**
 * 10.7.2 — Per-instance log fetcher.
 *
 * Fallback chain:
 *   1. /api/runtime?logs=tail
 *   2. /api/health diagnostic payload
 *   3. empty snapshot with a typed reason
 *
 * Hard cap: 200 lines per fetch. No streaming. No persistence.
 */

import { MANAGED_INSTANCE_HOST, DASHBOARD_SCAN_TIMEOUT_MS } from './constants.js';
import { internalFetch } from './internal-fetch.js';
import type { FetchLike } from './types.js';

export type InstanceLogLevel = 'info' | 'warn' | 'error';

export type InstanceLogLine = {
    ts: string;
    level: InstanceLogLevel;
    text: string;
};

export type InstanceLogSnapshot = {
    port: number;
    fetchedAt: string;
    lines: InstanceLogLine[];
    truncated: boolean;
    source: 'runtime' | 'health' | 'none';
    reason?: string;
};

const MAX_LINES = 200;

export type InstanceLogOptions = {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
};

function parseLevel(value: unknown): InstanceLogLevel {
    if (value === 'error' || value === 'warn' || value === 'info') return value;
    return 'info';
}

function normalizeLine(raw: unknown, fallbackTs: string): InstanceLogLine | null {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    const text = typeof entry["text"] === 'string'
        ? entry["text"]
        : typeof entry["message"] === 'string'
            ? entry["message"]
            : null;
    if (!text) return null;
    const ts = typeof entry["ts"] === 'string'
        ? entry["ts"]
        : typeof entry["timestamp"] === 'string'
            ? entry["timestamp"]
            : fallbackTs;
    return { ts, level: parseLevel(entry["level"]), text };
}

async function readJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json() as unknown;
}

function pickLinesArray(payload: unknown): unknown[] | null {
    if (!payload || typeof payload !== 'object') return null;
    const root = payload as Record<string, unknown>;
    if (Array.isArray(root["lines"])) return root["lines"];
    if (Array.isArray(root["logs"])) return root["logs"];
    const data = root["data"];
    if (data && typeof data === 'object') {
        const inner = data as Record<string, unknown>;
        if (Array.isArray(inner["lines"])) return inner["lines"];
        if (Array.isArray(inner["logs"])) return inner["logs"];
    }
    return null;
}

export async function fetchInstanceLogs(port: number, options: InstanceLogOptions = {}): Promise<InstanceLogSnapshot> {
    const fetchImpl = options.fetchImpl || internalFetch;
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0
        ? options.timeoutMs
        : DASHBOARD_SCAN_TIMEOUT_MS;
    const fetchedAt = new Date().toISOString();
    const baseUrl = `http://${MANAGED_INSTANCE_HOST}:${port}`;

    try {
        const runtime = await readJson(fetchImpl, `${baseUrl}/api/runtime?logs=tail`, timeoutMs);
        const raw = pickLinesArray(runtime);
        if (raw) {
            const lines = raw
                .map(item => normalizeLine(item, fetchedAt))
                .filter((line): line is InstanceLogLine => line !== null)
                .slice(-MAX_LINES);
            return { port, fetchedAt, lines, truncated: raw.length > MAX_LINES, source: 'runtime' };
        }
    } catch {
        // fall through to health
    }

    try {
        const health = await readJson(fetchImpl, `${baseUrl}/api/health`, timeoutMs);
        const raw = pickLinesArray(health);
        if (raw) {
            const lines = raw
                .map(item => normalizeLine(item, fetchedAt))
                .filter((line): line is InstanceLogLine => line !== null)
                .slice(-MAX_LINES);
            return { port, fetchedAt, lines, truncated: raw.length > MAX_LINES, source: 'health' };
        }
    } catch {
        // fall through to empty
    }

    return {
        port,
        fetchedAt,
        lines: [],
        truncated: false,
        source: 'none',
        reason: 'No log source reachable. Logs require runtime support on the target instance.',
    };
}
