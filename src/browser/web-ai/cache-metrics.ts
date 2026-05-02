import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wrapError } from './errors.js';

const METRICS_FILE = 'web-ai-metrics.jsonl';
const METRICS_WINDOW_MS = 7 * 86_400_000;

export interface CacheMetricEvent {
    type: 'lookup' | 'cache-hit-valid' | 'cache-hit-rejected' | 'cache-miss' | 'resolved' | 'false-heal' | string;
    ts?: string | number;
    source?: string;
    durationMs?: number;
    [key: string]: unknown;
}

export interface CacheMetricsReport {
    totalLookups: number;
    cacheHitsValid: number;
    cacheHitsRejected: number;
    cacheMisses: number;
    resolutionSources: Record<string, number>;
    falseHeals: number;
    avgDurationMs: number;
    p95DurationMs: number;
    cacheHitRate: number;
    selfHealRate: number;
}

export function recordCacheEvent(homeDir: string, event: CacheMetricEvent): void {
    try {
        mkdirSync(homeDir, { recursive: true });
        const path = join(homeDir, METRICS_FILE);
        const line = `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`;
        const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
        const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
        writeFileSync(tmpPath, existing + line);
        renameSync(tmpPath, path);
    } catch (err) {
        throw wrapError(err, {
            errorCode: 'internal.unhandled',
            stage: 'cache-metrics-record',
            retryHint: 'check-filesystem',
        });
    }
}

export function reportCacheMetricsFromEvents(homeDir: string): CacheMetricsReport | null {
    const path = join(homeDir, METRICS_FILE);
    if (!existsSync(path)) return null;
    try {
        const cutoff = new Date(Date.now() - METRICS_WINDOW_MS).toISOString();
        const events = readFileSync(path, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as CacheMetricEvent)
            .filter((event) => String(event.ts || '') > cutoff);
        const report: CacheMetricsReport = {
            totalLookups: 0,
            cacheHitsValid: 0,
            cacheHitsRejected: 0,
            cacheMisses: 0,
            resolutionSources: {},
            falseHeals: 0,
            avgDurationMs: 0,
            p95DurationMs: 0,
            cacheHitRate: 0,
            selfHealRate: 0,
        };
        const durations: number[] = [];
        for (const event of events) {
            if (event.type === 'lookup') report.totalLookups += 1;
            if (event.type === 'cache-hit-valid') report.cacheHitsValid += 1;
            if (event.type === 'cache-hit-rejected') report.cacheHitsRejected += 1;
            if (event.type === 'cache-miss') report.cacheMisses += 1;
            if (event.type === 'resolved' && event.source) {
                report.resolutionSources[event.source] = (report.resolutionSources[event.source] || 0) + 1;
            }
            if (event.type === 'false-heal') report.falseHeals += 1;
            if (typeof event.durationMs === 'number') durations.push(event.durationMs);
        }
        if (durations.length) {
            report.avgDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;
            const sorted = [...durations].sort((a, b) => a - b);
            report.p95DurationMs = sorted[Math.ceil(sorted.length * 0.95) - 1] || sorted[sorted.length - 1] || 0;
        }
        report.cacheHitRate = report.totalLookups > 0 ? report.cacheHitsValid / report.totalLookups : 0;
        const totalResolved = Object.values(report.resolutionSources).reduce((a, b) => a + b, 0);
        report.selfHealRate = totalResolved > 0 ? (totalResolved - report.cacheHitsValid) / totalResolved : 0;
        return report;
    } catch (err) {
        throw wrapError(err, {
            errorCode: 'internal.unhandled',
            stage: 'cache-metrics-report',
            retryHint: 'reset-metrics',
        });
    }
}

export function createMetricsCollector(input: { sink: (event: CacheMetricEvent & { ts: number }) => void }): { record(event: CacheMetricEvent): void } {
    return {
        record(event: CacheMetricEvent): void {
            input.sink({ ...event, ts: Date.now() });
        },
    };
}
