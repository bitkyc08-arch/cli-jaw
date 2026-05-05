import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function src(path: string): string {
    return readFileSync(join(process.cwd(), path), 'utf8');
}

test('backend agent_done DB and broadcast boundaries use sanitized tool logs', () => {
    const source = src('src/agent/lifecycle-handler.ts');

    assert.ok(source.includes('sanitizeToolLogForDurableStorage(mergedToolLog)'));
    assert.ok(source.includes('serializeSanitizedToolLog(sanitizedToolLog)'));
    assert.ok(source.includes("broadcast('agent_done', { text: finalContent, toolLog: sanitizedToolLog"));
    assert.ok(!source.includes('const toolLogJson = mergedToolLog.length ? JSON.stringify(mergedToolLog) : null'));
});

test('message and orchestrate snapshot API boundaries sanitize before res.json', () => {
    const server = src('server.ts');
    const orchestrate = src('src/routes/orchestrate.ts');

    assert.ok(server.includes('sanitizeSerializedToolLog(row["tool_log"]'));
    assert.ok(orchestrate.includes('function getSafeLiveRun(scope: string)'));
    assert.ok(orchestrate.includes('toolLog: sanitizeToolLogForDurableStorage(liveRun.toolLog)'));
    assert.ok(orchestrate.includes('activeRun: getSafeLiveRun(scope)'));
});

test('frontend history, cache, active-run, and virtual item paths use bounded tool logs', () => {
    const ui = src('public/js/ui.ts');

    assert.ok(ui.includes('parseToolLogBounded(toolLog)'));
    assert.ok(ui.includes('function normalizeMessageToolLog'));
    assert.ok(ui.includes('buildLazyVirtualMessageItem'));
    assert.ok(ui.includes('sanitizeToolLogForDurableStorage(entries)'));
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
