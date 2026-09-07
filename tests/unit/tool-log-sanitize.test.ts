import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_TOOL_LOG_ENTRIES,
    MAX_TOOL_LOG_JSON_CHARS,
    MAX_TOOL_LOG_RAW_INPUT_CHARS,
    MAX_TOOL_LOG_STRING_CHARS,
    parseToolLogBounded,
    omittedCountOf,
    sanitizeToolLogForDurableStorage,
    serializeSanitizedToolLog,
} from '../../src/shared/tool-log-sanitize.ts';
import { addBroadcastListener, broadcast, clearAllBroadcastListeners } from '../../src/core/bus.ts';
import { beginLiveRun, getLiveRun, replaceLiveRunTools, clearLiveRun } from '../../src/agent/live-run-state.ts';

test.afterEach(() => {
    clearAllBroadcastListeners();
    clearLiveRun('unit');
});

test('tool log sanitizer hard-caps fields, entry count, and serialized JSON', () => {
    const huge = 'x'.repeat(200_000);
    const entries = Array.from({ length: MAX_TOOL_LOG_ENTRIES + 20 }, (_v, index) => ({
        icon: huge,
        rawIcon: huge,
        label: `tool-${index}-${huge}`,
        detail: huge,
        toolType: `type-${huge}`,
        stepRef: `ref-${index}-${huge}`,
        status: `running-${huge}`,
    }));

    const sanitized = sanitizeToolLogForDurableStorage(entries);
    const serialized = serializeSanitizedToolLog(entries);

    assert.ok(sanitized.length <= MAX_TOOL_LOG_ENTRIES);
    assert.ok(serialized);
    assert.ok(serialized!.length <= MAX_TOOL_LOG_JSON_CHARS);
    for (const entry of sanitized) {
        assert.ok(entry.icon.length <= MAX_TOOL_LOG_STRING_CHARS);
        assert.ok(entry.label.length <= MAX_TOOL_LOG_STRING_CHARS);
        assert.ok((entry.rawIcon || '').length <= MAX_TOOL_LOG_STRING_CHARS);
        assert.ok((entry.toolType || '').length <= MAX_TOOL_LOG_STRING_CHARS);
        assert.ok((entry.stepRef || '').length <= MAX_TOOL_LOG_STRING_CHARS);
        assert.ok((entry.status || '').length <= MAX_TOOL_LOG_STRING_CHARS);
    }
    assert.ok(!serialized!.includes(huge.slice(0, 1000)));
});

test('shared detail budget favors the NEWEST entries on exhaustion (doc 86 §7)', () => {
    // 12 × 3000-char details = 36K raw against the 24K pool: the 8 NEWEST entries
    // must keep full detail; the oldest starve. Front-to-back allocation (the old
    // behavior) blanked the newest details instead — the entries the user actually
    // inspects on navigate-back.
    const big = 'x'.repeat(3_000);
    const entries = Array.from({ length: 12 }, (_v, i) => ({
        icon: '🔧', label: `tool-${i}`, detail: big, toolType: 'tool', status: 'done',
    }));
    const sanitized = sanitizeToolLogForDurableStorage(entries);

    assert.equal(sanitized.length, 12);
    assert.equal(sanitized[11]!.detail, big, 'newest entry keeps full detail');
    assert.equal(sanitized[4]!.detail, big, 'all 8 newest entries keep full detail');
    assert.notEqual(sanitized[3]!.detail, big, 'oldest entries starve once the pool is spent');
});

test('entries under the JSON cap keep full detail (no unconditional 180-char shrink)', () => {
    // doc 86 regression: every persisted row had detail capped at exactly 180
    // because fitToolLogToJsonCap shrank unconditionally.
    const detail = 'd'.repeat(1_000);
    const sanitized = sanitizeToolLogForDurableStorage([
        { icon: '🔧', label: 'exec', detail, toolType: 'tool', status: 'done' },
    ]);
    assert.equal(sanitized.length, 1);
    assert.equal(sanitized[0]!.detail, detail);
});

test('entry cap keeps the NEWEST entries with an omitted marker at the head', () => {
    const entries = Array.from({ length: MAX_TOOL_LOG_ENTRIES + 40 }, (_v, i) => ({
        icon: '🔧', label: `tool-${i}`, toolType: 'tool', status: 'done',
    }));
    const sanitized = sanitizeToolLogForDurableStorage(entries);

    assert.ok(sanitized.length <= MAX_TOOL_LOG_ENTRIES);
    assert.match(sanitized[0]!.label, /41 tool events omitted/);
    assert.equal(sanitized[sanitized.length - 1]!.label, `tool-${MAX_TOOL_LOG_ENTRIES + 39}`);
});

test('re-sanitizing an append-only log does not freeze the list or drop new entries', () => {
    // doc 86 regression: live-run state re-sanitizes ctx.toolLog on every tool
    // event; the old keep-first cap silently dropped every entry past 160 and
    // pinned the overflow counter at "1 omitted".
    let log: unknown[] = [];
    const total = MAX_TOOL_LOG_ENTRIES + 25;
    for (let i = 0; i < total; i++) {
        log.push({ icon: '🔧', label: `tool-${i}`, toolType: 'tool', status: 'done' });
        log = sanitizeToolLogForDurableStorage(log);
    }
    const last = log[log.length - 1] as { label: string };
    const head = log[0] as { label: string };
    assert.equal(last.label, `tool-${total - 1}`);
    assert.match(head.label, /26 tool events omitted/);
    assert.ok(log.length <= MAX_TOOL_LOG_ENTRIES);
});

test('bounded parse refuses oversized legacy raw JSON strings before JSON.parse', () => {
    const oversized = `[${' '.repeat(MAX_TOOL_LOG_RAW_INPUT_CHARS + 1)}]`;
    const parsed = parseToolLogBounded(oversized);

    assert.equal(parsed.length, 1);
    assert.match(parsed[0]!.label, /truncated|omitted/i);
});

test('broadcast and live-run state bound live tool payloads before JSON serialization', () => {
    const huge = 'z'.repeat(120_000);
    let seen: Record<string, any> | null = null;
    addBroadcastListener((_type, data) => {
        seen = data;
    });

    broadcast('agent_tool', {
        agentId: 'unit',
        icon: huge,
        label: huge,
        detail: huge,
        toolType: huge,
        stepRef: huge,
        status: huge,
    });

    assert.ok(seen);
    assert.ok(String(seen!.detail || '').length < huge.length);
    assert.ok(String(seen!.label || '').length <= MAX_TOOL_LOG_STRING_CHARS);

    beginLiveRun('unit', 'codex');
    const rawLog = [{ icon: '🔧', label: huge, detail: huge, toolType: 'tool', status: 'running' }];
    replaceLiveRunTools('unit', rawLog);
    const live = getLiveRun('unit');

    assert.ok(String(live.toolLog[0]!.detail || '').length < huge.length);
    assert.ok(String(live.toolLog[0]!.label || '').length <= MAX_TOOL_LOG_STRING_CHARS);
    assert.ok(String(rawLog[0]!.detail || '').length < huge.length);
});

test('tool log sanitizer preserves trace pointers without preserving raw detail', () => {
    const rawDetail = 'raw-line\n'.repeat(10_000);
    const runId = 'tr_1234567890abcdef1234567890abcdef';
    const serialized = serializeSanitizedToolLog([{
        icon: '🔧',
        label: 'exec',
        detail: rawDetail,
        toolType: 'tool',
        stepRef: 'step-1',
        traceRunId: runId,
        traceSeq: 42,
        detailAvailable: true,
        detailBytes: 123456,
        rawRetentionStatus: 'spilled',
        isEmployee: true,
    }]);

    assert.ok(serialized);
    assert.ok(serialized!.length <= MAX_TOOL_LOG_JSON_CHARS);
    const parsed = parseToolLogBounded(serialized);
    assert.equal(parsed[0]!.traceRunId, runId);
    assert.equal(parsed[0]!.traceSeq, 42);
    assert.equal(parsed[0]!.detailAvailable, true);
    assert.equal(parsed[0]!.detailBytes, 123456);
    assert.equal(parsed[0]!.rawRetentionStatus, 'spilled');
    assert.equal(parsed[0]!.isEmployee, true);
    assert.ok(!serialized!.includes(rawDetail.slice(0, 5000)));
});

test('snapshot known omissions survive partial reconstruction without double-counting overlap', () => {
    const tools = Array.from({ length: 161 }, (_, i) => ({ icon: 'x', label: `tool-${i}`, toolType: 'tool' }));
    for (const size of [0, 1, 159, 160, 161]) {
        const result = sanitizeToolLogForDurableStorage(tools.slice(0, size), { knownOmitted: 2 });
        assert.equal(omittedCountOf(result[0]), 2);
        assert.equal(result.length, Math.min(size, 159) + 1);
        assert.deepEqual(sanitizeToolLogForDurableStorage(result), result, 'ordinary re-sanitize keeps the recorded count');
    }
    const full = sanitizeToolLogForDurableStorage(tools);
    assert.deepEqual(sanitizeToolLogForDurableStorage(tools, { knownOmitted: 2 }), full);
    assert.equal(omittedCountOf(sanitizeToolLogForDurableStorage(full, { knownOmitted: 5 })[0]), 5);
    assert.deepEqual(sanitizeToolLogForDurableStorage(null, { knownOmitted: 2 }), []);
});

test('known omission is opt-in and invalid values keep existing sanitizer output', () => {
    for (const count of [0, 1, 159, 160, 161, 500]) {
        const tools = Array.from({ length: count }, (_, i) => ({ icon: 'x', label: `tool-${i}`, detail: 'large'.repeat(1000) }));
        const original = sanitizeToolLogForDurableStorage(tools);
        for (const knownOmitted of [undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.deepEqual(sanitizeToolLogForDurableStorage(tools, { knownOmitted }), original);
        }
        const reconstructed = sanitizeToolLogForDurableStorage(tools, { knownOmitted: 12 });
        assert.ok(reconstructed.length <= MAX_TOOL_LOG_ENTRIES);
        assert.ok(JSON.stringify(reconstructed).length <= MAX_TOOL_LOG_JSON_CHARS);
        assert.ok(omittedCountOf(reconstructed[0]) >= 12);
        // Existing detail truncation notices can change on a second pass; this
        // mode preserves count/order, not a new byte-idempotence contract.
        const repeated = sanitizeToolLogForDurableStorage(reconstructed);
        assert.deepEqual(repeated.map(tool => tool.label), reconstructed.map(tool => tool.label));
        assert.ok(JSON.stringify(repeated).length <= MAX_TOOL_LOG_JSON_CHARS);
    }
});
