import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function src(path: string): string {
    return readFileSync(join(process.cwd(), path), 'utf8');
}

test('backend agent_done DB and broadcast boundaries use sanitized tool logs', () => {
    const source = src('src/agent/lifecycle-handler.ts');

    // Persist unions ctx.toolLog (boss) + liveRun.toolLog (worker mirrors) by stepRef
    // since the tool-card hydration fix (devlog 260620 R1) — the old pick-one ternary
    // discarded the array that held the worker mirrors.
    assert.ok(source.includes('sanitizeToolLogForDurableStorage(unionToolLog)'));
    assert.ok(source.includes('for (const t of liveRun.toolLog) pushUnionTool(t)'), 'persist must union ctx + liveRun');
    assert.ok(!source.includes('liveRun.toolLog.length > ctx.toolLog.length ? liveRun.toolLog : ctx.toolLog'), 'pick-one ternary must be gone');
    assert.ok(source.includes('serializeSanitizedToolLog(sanitizedToolLog)'));
    // runTag(ctx) rides first since the replay-idempotency patch (260612 audit 08).
    assert.ok(source.includes("broadcast('agent_done', { ...runTag(ctx), text: finalContent, toolLog: sanitizedToolLog"));
});

test('message and orchestrate snapshot API boundaries sanitize before res.json', () => {
    // /api/messages lives in routes/messages.ts since the Phase 2 extraction (devlog 260609, 20).
    const server = src('src/routes/messages.ts');
    const orchestrate = src('src/routes/orchestrate.ts');

    // /api/messages routes tool_log through resolveToolLog (Option D, devlog 260620 P3),
    // which sanitizes internally: blob → sanitizeSerializedToolLog, trace → serializeSanitizedToolLog.
    assert.ok(server.includes('resolveToolLog(row["id"], row["tool_log"]'), 'main read resolves tool_log via Option D boundary');
    assert.ok(server.includes('return sanitizeSerializedToolLog(blobToolLog)'), 'resolveToolLog blob fallback still sanitizes');
    assert.ok(orchestrate.includes('function getSafeLiveRun(scope: string)'));
    assert.ok(orchestrate.includes('toolLog: sanitizeToolLogForDurableStorage(liveRun.toolLog)'));
    assert.ok(orchestrate.includes('activeRun: getSafeLiveRun(scope)'));
});

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
