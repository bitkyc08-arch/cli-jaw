import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function src(path: string): string {
    return readFileSync(join(process.cwd(), path), 'utf8');
}

// Backend persistence/broadcast and HTTP boundaries now run behavioral checks in
// print-activity-lifecycle.test.ts and live-run-trace-hydration.test.ts. Source-shape
// assertions here could not verify those boundaries and broke on equivalent refactors.

test('frontend history, cache, active-run, and virtual item paths use bounded tool logs', () => {
    const ui = src('public/js/ui.ts');
    const adapter = src('public/js/features/process-log-adapter.ts');
    const item = src('public/js/features/message-item-html.ts');

    assert.ok(adapter.includes('parseToolLogBounded(toolLog)'));
    assert.ok(adapter.includes('function normalizeMessageToolLog'));
    assert.ok(item.includes('buildLazyVirtualMessageItem'));
    assert.ok(adapter.includes('sanitizeToolLogForDurableStorage(entries)'));
    assert.ok(ui.includes('const snapshotToolLog = sanitizedToolLogEntries(snapshot.toolLog || [])'));
    assert.ok(ui.includes('const durableToolLog = sanitizedToolLogEntries('));
    assert.ok(ui.includes('vs.appendItem(buildLazyVirtualMessageItem'));
    assert.ok(!ui.includes('tool_log: toolLog ? JSON.stringify(toolLog) : null'));
});

test('VirtualScroll releases process details only for rehydratable ordinary unmounts', () => {
    const source = src('public/js/virtual-scroll.ts');

    assert.ok(source.includes('rehydratesProcessDetails?: boolean'));
    assert.ok(source.includes('appendItem(item: VirtualItem)'));
    assert.ok(source.includes('if (item?.rehydratesProcessDetails) releaseProcessBlockDetails(el)'));
    assert.ok(source.includes('releaseProcessBlockDetails(el);'));
});
