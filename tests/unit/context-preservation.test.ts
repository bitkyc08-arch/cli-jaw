import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildThreadPreamble, PREAMBLE_TOTAL_CAP } from '../../src/slack/context.ts';
import { formatHistoryForAgent } from '../../src/slack/history.ts';

// #518: the bot lost the thread it was in and asserted numbers with no source.
// Two of the three causes are bounds that cut from the wrong end — the history
// was rendered oldest-first and then truncated from the FRONT, so the messages
// a user means by "방금 네가 말한" were exactly the ones thrown away.

function historyLines(n: number): string {
    return Array.from({ length: n }, (_, i) =>
        `[2026-09-04 0${i % 10}:00] jun (U1): 메시지 ${String(i).padStart(4, '0')} ${'가'.repeat(60)}`,
    ).join('\n');
}

test('CTX-001: the preamble keeps the NEWEST messages when it overflows', () => {
    // The whole defect in one assertion. Head-truncation kept 메시지 0000 and
    // dropped the most recent turn, which is what the follow-up question refers to.
    const body = historyLines(400);
    const out = buildThreadPreamble(body, 400);
    assert.ok(out.includes('메시지 0399'), 'the most recent message must survive the cut');
    assert.ok(!out.includes('메시지 0000'), 'the oldest is what gets dropped instead');
});

test('CTX-002: the preamble is still bounded, delimiters included', () => {
    const out = buildThreadPreamble(historyLines(400), 400);
    assert.ok([...out].length <= PREAMBLE_TOTAL_CAP,
        `preamble must stay within ${PREAMBLE_TOTAL_CAP} code points, got ${[...out].length}`);
});

test('CTX-003: a short history is passed through untouched', () => {
    const body = '[2026-09-04 09:00] jun (U1): 안녕';
    const out = buildThreadPreamble(body, 1);
    assert.ok(out.includes(body), 'nothing to cut means nothing is cut');
    assert.ok(!out.includes('…'), 'and no truncation marker is added');
});

test('CTX-004: an empty body yields no block at all', () => {
    assert.equal(buildThreadPreamble('', 0), '');
    assert.equal(buildThreadPreamble('   ', 3), '');
});

test('CTX-005: the cap is large enough to carry a real conversation', () => {
    // The old 2100 cap left room for roughly 10-15 Korean messages including
    // their [timestamp] Name (Uxxx): framing — a thread routinely outran it.
    const out = buildThreadPreamble(historyLines(400), 400);
    const kept = (out.match(/메시지 \d{4}/g) || []).length;
    assert.ok(kept >= 40, `the window must hold a conversation, kept ${kept}`);
});

test('CTX-006: history rendering truncates whole lines from the front', () => {
    // Cutting mid-line leaves half a timestamp, which is worse than a missing
    // message: the agent cannot tell what it is looking at.
    const messages = Array.from({ length: 400 }, (_, i) => ({
        ts: String(1788000000 + i),
        user: 'U1',
        text: `메시지 ${String(i).padStart(4, '0')} ${'나'.repeat(60)}`,
    }));
    const out = formatHistoryForAgent(messages);
    assert.ok(out.includes('메시지 0399'), 'the newest rendered message survives');
    for (const line of out.split('\n')) {
        assert.match(line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, `every kept line is whole: ${line.slice(0, 40)}`);
    }
});

test('CTX-007: the render cap does not become the real preamble limit', () => {
    // Raising PREAMBLE_TOTAL_CAP alone was a no-op: this cut runs first, in the
    // same direction, and was the actual bottleneck.
    const messages = Array.from({ length: 400 }, (_, i) => ({
        ts: String(1788000000 + i),
        user: 'U1',
        text: `메시지 ${String(i).padStart(4, '0')} ${'다'.repeat(60)}`,
    }));
    const rendered = formatHistoryForAgent(messages);
    assert.ok(rendered.length >= PREAMBLE_TOTAL_CAP,
        `the render cap must not starve the preamble: rendered ${rendered.length} < cap ${PREAMBLE_TOTAL_CAP}`);
});
