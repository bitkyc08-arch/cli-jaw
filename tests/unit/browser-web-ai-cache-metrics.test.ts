import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMetricsCollector, recordCacheEvent, reportCacheMetricsFromEvents } from '../../src/browser/web-ai/cache-metrics.ts';

test('cache metrics records jsonl events and reports rates', () => {
    const home = mkdtempSync(join(tmpdir(), 'web-ai-cache-metrics-'));
    try {
        recordCacheEvent(home, { type: 'lookup', durationMs: 10 });
        recordCacheEvent(home, { type: 'cache-hit-valid', durationMs: 20 });
        recordCacheEvent(home, { type: 'resolved', source: 'css-fallback', durationMs: 30 });
        recordCacheEvent(home, { type: 'false-heal' });

        const report = reportCacheMetricsFromEvents(home);
        assert.equal(report?.totalLookups, 1);
        assert.equal(report?.cacheHitsValid, 1);
        assert.equal(report?.resolutionSources['css-fallback'], 1);
        assert.equal(report?.falseHeals, 1);
        assert.equal(report?.cacheHitRate, 1);
        assert.equal(report?.p95DurationMs, 30);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('cache metrics collector forwards timestamped events to sink', () => {
    const events: Array<{ type: string; ts: number }> = [];
    const collector = createMetricsCollector({ sink: (event) => events.push(event as { type: string; ts: number }) });
    collector.record({ type: 'lookup' });
    assert.equal(events[0]?.type, 'lookup');
    assert.equal(typeof events[0]?.ts, 'number');
});
