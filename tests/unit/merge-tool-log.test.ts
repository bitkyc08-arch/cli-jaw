import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLatestTools } from '../../src/agent/merge-tool-log.js';
import type { ToolEntry } from '../../src/types/agent.js';
import type { SanitizedToolLogEntry } from '../../src/shared/tool-log-sanitize.js';
import { sanitizeToolLogForDurableStorage } from '../../src/shared/tool-log-sanitize.js';

function tool(label: string, fields: Partial<ToolEntry> = {}): ToolEntry {
    return { icon: '🔧', label, toolType: 'tool', ...fields };
}

test('run/ref and run/seq identity domains cannot collide, including delimiter-like refs', () => {
    const result = mergeLatestTools([
        tool('ref', { traceRunId: 'run', stepRef: 'trace:2' }),
        tool('seq', { traceRunId: 'run', traceSeq: 2 }),
        tool('other-run', { traceRunId: 'other', stepRef: 'trace:2' }),
        tool('delimiter-ref', { traceRunId: 'run', stepRef: 'x:ref:y' }),
        tool('delimiter-run', { traceRunId: 'run:ref:x', stepRef: 'y' }),
    ], [tool('latest-ref', { traceRunId: 'run', stepRef: 'trace:2', status: 'done' })], 'fallback');
    assert.deepEqual(result.map(t => t.label), ['latest-ref', 'seq', 'other-run', 'delimiter-ref', 'delimiter-run']);
});

test('fallback scopes boss entries but never unscoped workers; unknown runs stay distinct', () => {
    const result = mergeLatestTools([
        tool('boss', { stepRef: 'same' }),
        tool('worker-a', { stepRef: 'same', isEmployee: true }),
        tool('worker-b', { stepRef: 'same', isEmployee: true }),
    ], [
        tool('boss-done', { traceRunId: 'boss-run', stepRef: 'same', status: 'done' }),
        tool('child', { traceRunId: 'child-run', stepRef: 'same', isEmployee: true }),
        tool('unknown-child', { stepRef: 'same', isEmployee: true }),
    ], 'boss-run');
    assert.deepEqual(result.map(t => t.label), ['boss-done', 'worker-a', 'worker-b', 'child', 'unknown-child']);
    assert.equal(mergeLatestTools([tool('unknown', { stepRef: 'same' })], [tool('unknown', { stepRef: 'same' })], '').length, 2);
});

test('identityless entries occur once per input occurrence, without merging by label', () => {
    const anonymous = tool('anonymous');
    const result = mergeLatestTools([anonymous, { ...anonymous }], [{ ...anonymous }], 'run');
    assert.equal(result.length, 3);
    assert.deepEqual(result.map(t => t.label), ['anonymous', 'anonymous', 'anonymous']);
    assert.equal(mergeLatestTools([anonymous], [], 'run').length, 1, 'primary anonymous is not appended twice');
    assert.equal(mergeLatestTools([], [anonymous], 'run').length, 1);
    assert.deepEqual(mergeLatestTools([], [], ''), []);
});

test('invalid seq pointers do not identify tools; a nonempty ref takes precedence over seq', () => {
    for (const traceSeq of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(mergeLatestTools([tool('a', { traceSeq })], [tool('b', { traceSeq })], 'run').length, 2);
    }
    const result = mergeLatestTools([
        tool('a', { stepRef: 'a', traceSeq: 1 }), tool('b', { stepRef: 'b', traceSeq: 1 }),
    ], [tool('a-done', { stepRef: 'a', traceSeq: 2, status: 'done' })], 'run');
    assert.deepEqual(result.map(t => t.label), ['a-done', 'b']);
});

test('latest within each source wins equal status while primary wins source ties and order', () => {
    const result = mergeLatestTools([
        tool('boss-old', { stepRef: 'boss', status: 'running' }),
        tool('boss-second', { stepRef: 'second', status: 'done' }),
        tool('boss-latest', { stepRef: 'boss', status: 'running' }),
    ], [
        tool('worker-old', { traceRunId: 'child', stepRef: 'worker', isEmployee: true, status: 'done' }),
        tool('mirror-boss', { stepRef: 'boss', status: 'running' }),
        tool('worker-latest', { traceRunId: 'child', stepRef: 'worker', isEmployee: true, status: 'done' }),
    ], 'run');
    assert.deepEqual(result.map(t => t.label), ['boss-latest', 'boss-second', 'worker-latest']);
});

test('terminal status never regresses within either source or across sources', () => {
    for (const status of ['done', 'error', 'failed', 'completed', 'cancelled', 'canceled', 'interrupted', 'stopped']) {
        const terminal = tool('terminal', { stepRef: 'same', status, detail: 'final result' });
        const running = tool('stale', { stepRef: 'same', status: 'running', detail: 'in progress' });
        for (const [primary, mirrors] of [
            [[terminal, running], []], [[], [terminal, running]],
            [[terminal], [running]], [[running], [terminal]],
        ] as [ToolEntry[], ToolEntry[]][]) {
            const result = mergeLatestTools(primary, mirrors, 'run');
            assert.equal(result.length, 1);
            assert.equal(result[0]?.status, status);
            assert.equal(result[0]?.detail, 'final result');
        }
    }
});

test('explicit empty detail clears old content; undefined preserves prior detail', () => {
    const old = tool('old', { stepRef: 'same', status: 'done', detail: 'old detail' });
    const empty = tool('empty', { stepRef: 'same', status: 'done', detail: '' });
    const missing = tool('missing', { stepRef: 'same', status: 'done' });
    assert.equal(Object.hasOwn(mergeLatestTools([missing], [missing], 'run')[0]!, 'detail'), false);
    assert.equal(mergeLatestTools([old, empty], [], 'run')[0]?.detail, '');
    assert.equal(mergeLatestTools([old, missing], [], 'run')[0]?.detail, 'old detail');
    assert.equal(mergeLatestTools([empty], [old], 'run')[0]?.detail, '');
    assert.equal(mergeLatestTools([missing], [old, empty], 'run')[0]?.detail, '');
    assert.equal(mergeLatestTools([missing], [old, missing], 'run')[0]?.detail, 'old detail');
    assert.equal(mergeLatestTools([old], [empty], 'run')[0]?.detail, 'old detail', 'primary wins equal status');
    assert.equal(mergeLatestTools([tool('running', { stepRef: 'same', status: 'running', detail: 'old' })], [empty], 'run')[0]?.detail, '');
});

test('latest mirror detail fills a primary omission without replacing primary label', () => {
    const result = mergeLatestTools([tool('primary', { stepRef: 'same', status: 'done' })], [
        tool('mirror-old', { stepRef: 'same', status: 'done', detail: 'first' }),
        tool('mirror-latest', { stepRef: 'same', status: 'done', detail: 'second' }),
    ], 'run');
    assert.equal(result[0]?.label, 'primary');
    assert.equal(result[0]?.detail, 'second');
});

test('readonly inputs are untouched and mirror toolType defaults to the shared ToolEntry port', () => {
    const primary = Object.freeze([Object.freeze(tool('primary', { stepRef: 'same', detail: 'original' }))]);
    const mirrors: readonly SanitizedToolLogEntry[] = Object.freeze([
        Object.freeze({ icon: '🔧', label: 'mirror', stepRef: 'same', status: 'done', detail: '' }),
        Object.freeze({ icon: '🤖', label: 'anonymous' }),
    ]);
    const result = mergeLatestTools(primary, mirrors, 'run');
    result[0]!.label = 'changed';
    assert.equal(primary[0]?.label, 'primary');
    assert.equal(primary[0]?.detail, 'original');
    assert.equal(mirrors[0]?.label, 'mirror');
    assert.equal(result[1]?.toolType, 'tool');
});

test('a small primary plus capped 161-tool RAM mirrors keeps one head marker and 159 real tools after sanitize', () => {
    const mirrors = sanitizeToolLogForDurableStorage(Array.from({ length: 161 }, (_, i) =>
        tool(`mirror-${i + 1}`, { stepRef: `item-${i + 1}`, status: 'done' })));
    assert.equal(mirrors[0]?.label, '2 tool events omitted');
    const merged = mergeLatestTools([tool('boss', { stepRef: 'boss' })], mirrors, 'run');
    assert.equal(merged[0]?.label, '2 tool events omitted', 'the mirror marker precedes the primary tools');
    assert.equal(merged[1]?.label, 'boss', 'real primary tools still precede real mirror tools');
    const sanitized = sanitizeToolLogForDurableStorage(merged);
    assert.equal(sanitized.length, 160);
    assert.equal(sanitized[0]?.label, '3 tool events omitted', 'only the final sanitizer accounts for the extra capped tool');
    assert.deepEqual(sanitized.slice(1).map(t => t.label), Array.from({ length: 159 }, (_, i) => `mirror-${i + 3}`));
    assert.deepEqual(sanitizeToolLogForDurableStorage(mergeLatestTools([], mirrors, 'run')), mirrors, 'empty primary retains the RAM fallback marker');
});

test('markers from both sources collapse to the primary marker at the head without summing or tool identity collisions', () => {
    const primaryMarker = tool('5 tool events omitted', { icon: '⚠️', stepRef: 'boss', status: 'done' });
    const mirrorMarker = tool('9 tool events omitted', { icon: '⚠️', stepRef: 'worker', status: 'done' });
    const primary = [tool('boss', { stepRef: 'boss' }), primaryMarker, { ...primaryMarker }];
    const mirrors = [tool('worker', { stepRef: 'worker' }), mirrorMarker, { ...mirrorMarker }];
    const merged = mergeLatestTools(primary, mirrors, 'run');
    assert.deepEqual(merged.map(t => t.label), ['5 tool events omitted', 'boss', 'worker']);
    assert.deepEqual(sanitizeToolLogForDurableStorage(merged).map(t => t.label), ['5 tool events omitted', 'boss', 'worker']);
    assert.equal(primary[0]?.label, 'boss', 'inputs stay in their original order');
    assert.equal(mirrors[0]?.label, 'worker');
    assert.deepEqual(mergeLatestTools([], [mirrorMarker, { ...mirrorMarker }], 'run'), [mirrorMarker]);
});
