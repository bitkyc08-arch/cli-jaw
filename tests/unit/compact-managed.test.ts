import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COMPACT_MARKER_CONTENT,
    MANAGED_COMPACT_PREFIX,
    buildManagedCompactSummaryForTest,
    getRowsSinceLatestCompactForTest,
    isCompactMarkerRow,
} from '../../src/core/compact.ts';

test('isCompactMarkerRow recognizes managed compact marker rows', () => {
    assert.equal(isCompactMarkerRow({
        role: 'assistant',
        content: COMPACT_MARKER_CONTENT,
        trace: `${MANAGED_COMPACT_PREFIX}\nkeep only these facts:`,
    }), true);
    assert.equal(isCompactMarkerRow({
        role: 'assistant',
        content: 'something else',
        trace: `${MANAGED_COMPACT_PREFIX}\nkeep only these facts:`,
    }), false);
});

test('getRowsSinceLatestCompactForTest keeps only rows after latest compact marker', () => {
    const rows = [
        { role: 'assistant', content: 'Latest assistant reply' },
        { role: 'user', content: 'Latest user request' },
        { role: 'assistant', content: COMPACT_MARKER_CONTENT, trace: `${MANAGED_COMPACT_PREFIX}\nkeep only these facts:` },
        { role: 'assistant', content: 'Older assistant reply' },
        { role: 'user', content: 'Older user request' },
    ];

    assert.deepEqual(
        getRowsSinceLatestCompactForTest(rows),
        [
            { role: 'user', content: 'Latest user request' },
            { role: 'assistant', content: 'Latest assistant reply' },
        ],
    );
});

test('buildManagedCompactSummaryForTest produces deterministic summary with instructions', () => {
    const summary = buildManagedCompactSummaryForTest([
        { role: 'assistant', content: 'Most recent answer with\n\n✅ $0.0100 · 2턴 · 1.0s' },
        { role: 'user', content: 'Need to preserve the deployment status and rollback plan.' },
    ], 'keep deployment status only');

    assert.ok(summary.startsWith(MANAGED_COMPACT_PREFIX));
    assert.ok(summary.includes('focus instructions: keep deployment status only'));
    assert.ok(summary.includes('[user] Need to preserve the deployment status and rollback plan.'));
    assert.ok(summary.includes('[assistant] Most recent answer with'));
    assert.ok(summary.includes('discard everything else.'));
    assert.ok(!summary.includes('$0.0100'), 'cost footer should be stripped from summary');
});

test('isCompactMarkerRow rejects non-assistant roles', () => {
    assert.equal(isCompactMarkerRow({
        role: 'user',
        content: COMPACT_MARKER_CONTENT,
        trace: `${MANAGED_COMPACT_PREFIX}\nkeep only these facts:`,
    }), false);
});

test('isCompactMarkerRow rejects missing trace prefix', () => {
    assert.equal(isCompactMarkerRow({
        role: 'assistant',
        content: COMPACT_MARKER_CONTENT,
        trace: 'Some other trace content',
    }), false);
});

test('getRowsSinceLatestCompactForTest returns all rows when no marker present', () => {
    const rows = [
        { role: 'assistant', content: 'reply2' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg1' },
    ];
    const result = getRowsSinceLatestCompactForTest(rows);
    assert.equal(result.length, 4);
    assert.equal(result[0].content, 'msg1');
    assert.equal(result[3].content, 'reply2');
});

test('getRowsSinceLatestCompactForTest stops at first (latest) marker only', () => {
    const marker = { role: 'assistant', content: COMPACT_MARKER_CONTENT, trace: `${MANAGED_COMPACT_PREFIX}\nfacts` };
    const rows = [
        { role: 'user', content: 'new msg' },
        marker,
        { role: 'user', content: 'old msg' },
        { ...marker, trace: `${MANAGED_COMPACT_PREFIX}\nolder facts` },
        { role: 'user', content: 'very old msg' },
    ];
    const result = getRowsSinceLatestCompactForTest(rows);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'new msg');
});

test('buildManagedCompactSummaryForTest uses default instructions when empty', () => {
    const summary = buildManagedCompactSummaryForTest([
        { role: 'user', content: 'Hello' },
    ], '');
    assert.ok(summary.includes('Preserve the active task'));
});

test('buildManagedCompactSummaryForTest strips tool_call tags from summary', () => {
    const summary = buildManagedCompactSummaryForTest([
        { role: 'assistant', content: 'Result <tool_call>some tool</tool_call> done' },
    ]);
    assert.ok(!summary.includes('<tool_call>'));
    assert.ok(summary.includes('Result'));
});

test('buildManagedCompactSummaryForTest caps at 8 turns', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
    }));
    const summary = buildManagedCompactSummaryForTest(rows);
    const bulletCount = (summary.match(/^- \[/gm) || []).length;
    assert.ok(bulletCount <= 8, `Expected ≤8 bullets but got ${bulletCount}`);
});
