import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';
import { createActivityItem, updateActivityItem } from '../../src/cli/tui/activity.js';
import {
    createActivityHistoryPanel, openActivityHistory, moveActivityHistory, moveActivityTurn,
    renderActivityHistory, createActivityPasteDrain, consumeActivityHistoryInput,
    sliceActivityAnswerViewport, activityHistoryScrollLimit, setActivityHistoryAnswer,
} from '../../src/cli/tui/activity-history.js';

const base = { version: 1 as const, runId: 'run', sessionId: 'chat', scope: 'local:chat', turnId: 'turn' };
const start: RuntimeEvent = { ...base, seq: 1, kind: 'turn-start', provider: 'codex-app' };
const message: RuntimeEvent = { ...base, seq: 7, kind: 'message', itemId: 'm', phase: 'commentary',
    operation: 'append', text: 'First chunk' };
const replacement: RuntimeEvent = { ...message, seq: 19, operation: 'replace', text: 'Replacement only' };
const pasteStart = '\x1b[200~';
const pasteEnd = '\x1b[201~';

function retained(events: RuntimeEvent[] = [start, message, replacement]) {
    const panel = createActivityHistoryPanel();
    openActivityHistory(panel, [createActivityItem(start)]);
    panel.events = events;
    panel.through = events.at(-1)?.seq ?? 0;
    moveActivityHistory(panel, 0);
    return panel;
}

test('empty and closed panels have no phantom records or live preview', () => {
    const panel = createActivityHistoryPanel();
    assert.deepEqual(panel, { open: false, runId: null, seq: null, offset: 0, expanded: false,
        message: '', loading: false, runs: [], events: [], through: 0, incomplete: false,
        loss: null, preview: null, controller: null, generation: 0,
        discoveryLimited: false, discoveryLoaded: false, discoveryAfter: null,
        sessionId: null, originalScope: null, answerView: false, answer: { kind: 'unloaded' } });
    assert.deepEqual(renderActivityHistory(panel, 80, 20), []);
    openActivityHistory(panel, []);
    assert.equal(panel.open, true);
    moveActivityHistory(panel, 1);
    assert.equal(panel.seq, null);
    assert.equal(moveActivityTurn(panel, 1), false);
    assert.match(renderActivityHistory(panel, 100, 20).join('\n'), /No retained|No Activity/);
    for (const size of [0, -1, NaN, Infinity]) {
        assert.deepEqual(renderActivityHistory(panel, 80, size), []);
        assert.deepEqual(renderActivityHistory(panel, size, 20), []);
    }
});

test('every split of paste markers discards embedded Enter, Ctrl+C, Escape and F6', () => {
    for (let left = 1; left < pasteStart.length; left++) {
        for (let right = 1; right < pasteEnd.length; right++) {
            const drain = createActivityPasteDrain();
            assert.deepEqual(drain, { active: false, pending: '' });
            for (const chunk of [pasteStart.slice(0, left), pasteStart.slice(left),
                'pasted\r\n\x03\x1b\x1b[17~', pasteEnd.slice(0, right)]) {
                assert.deepEqual(consumeActivityHistoryInput(drain, chunk), []);
                assert.ok(drain.pending.length <= 5);
            }
            assert.deepEqual(consumeActivityHistoryInput(drain, pasteEnd.slice(right)), []);
            assert.deepEqual(drain, { active: false, pending: '' });
            assert.deepEqual(consumeActivityHistoryInput(drain, 'x'), ['x']);
        }
    }
});

test('paste drain survives panel close and replacement without retaining body', () => {
    const drain = createActivityPasteDrain();
    let panel = retained();
    assert.deepEqual(consumeActivityHistoryInput(drain, pasteStart + 'body'), []);
    panel.open = false;
    panel = createActivityHistoryPanel();
    assert.equal(panel.open, false);
    for (const chunk of ['x'.repeat(1_000_000) + '\r\x03\x1b', '', '[20', '1', '~']) {
        assert.deepEqual(consumeActivityHistoryInput(drain, chunk), []);
        assert.ok(drain.pending.length <= 5);
        assert.ok(pasteEnd.startsWith(drain.pending));
    }
    assert.deepEqual(drain, { active: false, pending: '' });
    assert.deepEqual(consumeActivityHistoryInput(drain, '\x03\r'), ['\x03', '\r']);
});

test('outside-paste tokens retain keymap semantics and delayed Escape can be flushed', () => {
    const drain = createActivityPasteDrain();
    assert.deepEqual(consumeActivityHistoryInput(drain, '\x1b[A\r' + pasteStart + 'bad\x03' + pasteEnd + 'R'),
        ['\x1b[A', '\r', 'R']);
    assert.deepEqual(consumeActivityHistoryInput(drain, '\x1b'), []);
    assert.equal(drain.pending, '\x1b');
    assert.deepEqual(consumeActivityHistoryInput(drain, ''), ['\x1b']);
    assert.equal(drain.pending, '');
    assert.deepEqual(consumeActivityHistoryInput(drain, '\x1b[20'), []);
    assert.deepEqual(consumeActivityHistoryInput(drain, '9~'), ['\x1b[209~']);
    assert.deepEqual(consumeActivityHistoryInput(drain, '\x1b[17~\x03'), ['\x1b[17~', '\x03']);
});

test('one-byte chunks and false end prefixes cannot leak pasted controls', () => {
    const drain = createActivityPasteDrain();
    const payload = pasteStart + '\x1b[20x\x03\r\x1b[201\x1b[201~';
    for (const char of payload) {
        assert.deepEqual(consumeActivityHistoryInput(drain, char), []);
        assert.ok(drain.pending.length <= 5);
    }
    assert.equal(drain.active, false);
    assert.deepEqual(consumeActivityHistoryInput(drain, 'a' + pasteStart + pasteEnd + 'b'), ['a', 'b']);
});

test('sparse seq navigation starts on content and never follows incoming records', () => {
    const panel = retained();
    assert.equal(panel.seq, 7);
    panel.offset = 8;
    panel.expanded = true;
    panel.events.push({ ...message, seq: 40, text: 'Later chunk' });
    renderActivityHistory(panel, 80, 18);
    assert.equal(panel.seq, 7);
    assert.equal(panel.offset, 8);
    moveActivityHistory(panel, 1);
    assert.equal(panel.seq, 19);
    assert.equal(panel.offset, 0);
    assert.equal(panel.expanded, true);
    moveActivityHistory(panel, -100);
    assert.equal(panel.seq, 1);
    moveActivityHistory(panel, 100);
    assert.equal(panel.seq, 40);
    moveActivityHistory(panel, 1);
    assert.equal(panel.seq, 40);
});

test('reopen keeps retained selection; switching run clears only run display state', () => {
    const panel = retained();
    const other = createActivityItem({ ...start, runId: 'other' });
    panel.offset = 3;
    panel.expanded = true;
    panel.open = false;
    const controller = new AbortController();
    panel.controller = controller;
    panel.generation = 12;
    openActivityHistory(panel, [other]);
    assert.equal(panel.runId, 'run');
    assert.equal(panel.seq, 7);
    assert.equal(panel.offset, 3);
    assert.equal(panel.expanded, true);
    assert.equal(panel.preview, null);
    assert.equal(moveActivityTurn(panel, 1), true);
    assert.equal(panel.runId, 'other');
    assert.deepEqual(panel.events, []);
    assert.equal(panel.seq, null);
    assert.equal(panel.offset, 0);
    assert.equal(panel.through, 0);
    assert.equal(panel.preview, null);
    assert.equal(panel.controller, controller);
    assert.equal(panel.generation, 12);
    assert.equal(controller.signal.aborted, false);
    assert.equal(moveActivityTurn(panel, 1), false);
});

test('first open picks latest displayed wrapper and never fabricates preview events', () => {
    const panel = createActivityHistoryPanel();
    const latest = createActivityItem({ ...start, runId: 'latest' }, true);
    updateActivityItem(latest, { ...message, runId: 'latest', text: 'Bounded preview text' });
    openActivityHistory(panel, [createActivityItem(start), latest]);
    assert.equal(panel.runId, 'latest');
    assert.equal(panel.preview, latest);
    assert.deepEqual(panel.events, []);
    assert.equal(panel.seq, null);
    assert.match(renderActivityHistory(panel, 100, 30).join('\n'), /Live preview/);
    panel.events = [{ ...message, runId: 'latest', text: 'Retained bytes' }];
    panel.expanded = true;
    const output = renderActivityHistory(panel, 100, 30).join('\n');
    assert.match(output, /Retained bytes/);
    assert.doesNotMatch(output, /Live preview|Bounded preview text/);
});

test('bounded descriptor discovery preserves the inspected run and deduplicates wrapper IDs', () => {
    const panel = retained();
    const turns = Array.from({ length: 300 }, (_, i) => createActivityItem({ ...start, runId: `new-${i}` }));
    openActivityHistory(panel, [...turns, turns[299]!]);
    assert.equal(panel.runs.length, 256);
    assert.equal(new Set(panel.runs.map(run => run.id)).size, 256);
    assert.ok(panel.runs.some(run => run.id === 'run'));
    assert.ok(panel.runs.some(run => run.id === 'new-299'));
    assert.equal(panel.seq, 7);
    assert.equal(panel.runId, 'run');
    assert.equal(panel.discoveryLimited, true);
    assert.equal(panel.incomplete, false);
});

test('record detail preserves append/replace, identity and full selected body', () => {
    const long = { ...message, parentItemId: 'parent', text: '한'.repeat(5000) + 'END_OF_RECORD' };
    const panel = retained([start, long, replacement]);
    panel.expanded = true;
    let output = renderActivityHistory(panel, 120, 200).join('\n');
    assert.match(output, /seq 7.*append/);
    assert.match(output, /Session: chat/);
    assert.match(output, /Scope: local:chat/);
    assert.match(output, /Turn: turn/);
    assert.match(output, /Item: m/);
    assert.match(output, /Parent: parent/);
    assert.match(output, /END_OF_RECORD/);
    moveActivityHistory(panel, 1);
    output = renderActivityHistory(panel, 100, 30).join('\n');
    assert.match(output, /seq 19.*replace/);
    assert.match(output, /Replacement only/);
    assert.doesNotMatch(output, /END_OF_RECORD|First chunk/);
});

test('null journal preview, empty journal preview and empty message remain distinct', () => {
    for (const [finalText, expected] of [[null, /Journal preview \(redacted\): absent \(null\)/], ['', /Journal preview \(redacted\): empty/]] as const) {
        const panel = retained([{ ...base, seq: 4, kind: 'turn-end', status: 'stopped', finalText }]);
        panel.expanded = true;
        assert.match(renderActivityHistory(panel, 100, 30).join('\n'), expected);
    }
    const panel = retained([{ ...message, text: '' }]);
    panel.expanded = true;
    assert.match(renderActivityHistory(panel, 100, 30).join('\n'), /Text: \(empty\)/);
});

test('requests expose fields and options as read-only text, never approval actions', () => {
    const event: RuntimeEvent = { ...base, seq: 4, kind: 'request', requestId: 'req', requestType: 'approval',
        view: { title: 'Read file?', fields: [{ id: 'permission', label: 'Access', multiSelect: true,
            allowFreeform: false, options: [{ id: 'yes', label: 'Allow' }, { id: 'no', label: 'Deny' }] }] } };
    const panel = retained([event]);
    panel.expanded = true;
    const output = renderActivityHistory(panel, 100, 40).join('\n');
    for (const text of ['Read-only', 'Read file?', 'req', 'permission', 'Access', 'yes', 'Allow', 'no', 'Deny',
        'multiSelect: true', 'allowFreeform: false']) assert.ok(output.includes(text), text);
    assert.doesNotMatch(output, /Enter.*(?:approve|submit|respond)/i);
    assert.deepEqual(panel.events, [event]);
});

test('tool and lifecycle detail displays every optional payload including zero usage', () => {
    const events: RuntimeEvent[] = [
        { ...base, seq: 2, kind: 'tool', itemId: 't', name: 'Read', status: 'error', input: 'INPUT', output: '', detail: 'DETAIL' },
        { ...base, seq: 3, kind: 'reasoning', itemId: 'r', operation: 'replace', text: 'REASON' },
        { ...base, seq: 4, kind: 'usage', inputTokens: 0, outputTokens: 12 },
        { ...base, seq: 5, kind: 'request-settled', requestId: 'settled-id' },
        { ...base, seq: 6, kind: 'turn-end', status: 'error', finalText: 'FINAL_BYTES', error: 'ERROR_BYTES' },
    ];
    const expected = [/Read \(error\)[\s\S]*INPUT[\s\S]*Output: \(empty\)[\s\S]*DETAIL/,
        /Reasoning.*replace[\s\S]*REASON/, /inputTokens: 0[\s\S]*outputTokens: 12[\s\S]*cachedTokens: absent/,
        /settled-id/, /FINAL_BYTES[\s\S]*ERROR_BYTES/];
    for (let index = 0; index < events.length; index++) {
        const panel = retained([events[index]!]);
        panel.expanded = true;
        assert.match(renderActivityHistory(panel, 100, 40).join('\n'), expected[index]!);
    }
});

test('loading, error, durable gap and missing selection are visible without stealing selection', () => {
    const panel = retained();
    panel.loading = true;
    panel.message = 'Unable to load history; R to retry.';
    panel.incomplete = true;
    panel.loss = 'retention';
    panel.seq = 999;
    panel.offset = 3;
    const output = renderActivityHistory(panel, 120, 20).join('\n');
    for (const pattern of [/Loading/, /Unable to load/, /incomplete/i, /gap/i, /retention/, /999.*not retained/]) {
        assert.match(output, pattern);
    }
    assert.equal(panel.seq, 999);
    assert.equal(panel.offset, 3);
});

test('selection stays visible in list viewport and detail scroll reaches the actual end', () => {
    const panel = retained(Array.from({ length: 80 }, (_, i) => ({ ...message, seq: 3 * i + 1, text: `record ${i}` })));
    moveActivityHistory(panel, 60);
    assert.match(renderActivityHistory(panel, 80, 8).join('\n'), /> seq 181/);
    panel.events = [{ ...message, seq: 181, text: Array.from({ length: 80 }, (_, i) => `row ${i}`).join('\n') }];
    panel.expanded = true;
    panel.offset = Number.MAX_SAFE_INTEGER;
    const output = renderActivityHistory(panel, 80, 10).join('\n');
    assert.match(output, /row 79/);
    assert.match(output, /seq 181/);
    assert.match(output, /F6\/Esc/);
    assert.equal(panel.offset, Number.MAX_SAFE_INTEGER);
});

test('rendered rows use actual CJK widths and strip VT controls in every surface', () => {
    const panel = retained([{ ...message, text: '한글 é 👩‍💻 한\n'.repeat(20) + '\x1b]52;c;SECRET\x07safe\x1b[2J' }]);
    panel.runId = '한글-run';
    panel.message = '\x1b[2JError';
    panel.loss = '\x1b]52;c;SECRET\x07retention';
    panel.expanded = true;
    // Independent cell oracle for this fixture: CJK/emoji=2, ASCII=1, marks=0.
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const width = (line: string) => [...segmenter.segment(line.normalize('NFC'))].reduce((sum, { segment }) =>
        sum + (/[한글]|\p{Extended_Pictographic}/u.test(segment) ? 2 : /^\p{Mark}+$/u.test(segment) ? 0 : 1), 0);
    for (const columns of [1, 2, 7, 20, 40, 80]) {
        for (const height of [1, 2, 5, 15]) {
            const rows = renderActivityHistory(panel, columns, height);
            assert.ok(rows.length <= height);
            assert.ok(rows.every(row => width(row) <= columns), `${columns}x${height}`);
            assert.ok(rows.every(row => !row.includes('\n')));
            assert.doesNotMatch(rows.join('\n'), /[\x00-\x08\x0b-\x1f\x7f-\x9f]|SECRET/);
        }
    }
});

test('keyboard legend includes navigation, detail, close and retry in the rendered panel', t => {
    const output = renderActivityHistory(retained(), 160, 20).join('\n');
    for (const token of ['F6/Esc', '↑/↓', '←/→', 'Enter', 'A saved answer', 'PgUp/PgDn', 'Home/End', 'R']) {
        assert.ok(output.includes(token), token);
    }
    const panel = retained();
    panel.expanded = true;
    t.diagnostic('Retained detail at 80 columns:\n' + renderActivityHistory(panel, 80, 18).join('\n'));
});

test('saved MESSAGE view never substitutes journal preview and keeps absent/error/empty/whitespace distinct', () => {
    const panel = retained([{ ...base, seq: 7, kind: 'turn-end', status: 'done', finalText: 'REDACTED_JOURNAL' }]);
    panel.answerView = true;
    panel.sessionId = 'chat'; panel.originalScope = 'old:scope';
    const message = { id: 23, role: 'assistant' as const, content: 'EXACT_SAVED', trace_run_id: 'run', session_id: 'chat' };
    for (const [kind, pattern] of [
        ['unloaded', /not loaded/], ['loading', /Loading saved answer/],
        ['absent', /MESSAGE is absent/], ['unavailable', /unavailable/],
    ] as const) {
        setActivityHistoryAnswer(panel, { kind });
        const out = renderActivityHistory(panel, 100, 14).join('\n');
        assert.match(out, pattern); assert.doesNotMatch(out, /REDACTED_JOURNAL|EXACT_SAVED/);
    }
    for (const content of ['EXACT_SAVED', '', '   \n ']) {
        setActivityHistoryAnswer(panel, { kind: 'saved', message: { ...message, content } });
        const out = renderActivityHistory(panel, 100, 14).join('\n');
        assert.match(out, /Original scope: old:scope/);
        assert.doesNotMatch(out, /REDACTED_JOURNAL|unavailable|MESSAGE is absent/);
        if (content === '') assert.match(out, /authoritative empty/);
        else if (content.trim()) assert.match(out, /EXACT_SAVED/);
        else assert.doesNotMatch(out, /authoritative empty/);
        assert.equal(panel.answer.kind === 'saved' && panel.answer.message.content, content);
    }
    moveActivityHistory(panel, 0); panel.expanded = true;
    assert.equal(panel.answerView, false);
    assert.match(renderActivityHistory(panel, 100, 20).join('\n'), /Journal preview \(redacted\):\nREDACTED_JOURNAL/);
});

test('saved answer viewport is bounded for many rows, clamps End and invalidates on width/message/run', () => {
    const text = 'row\n'.repeat(100_000) + 'LAST';
    const page = sliceActivityAnswerViewport(text, 8, Number.MAX_SAFE_INTEGER, 4);
    assert.equal(page.totalRows, 100_001);
    assert.equal(page.offset, 99_997);
    assert.deepEqual(page.rows, ['row', 'row', 'row', 'LAST']);
    const panel = retained(); panel.answerView = true;
    const message = { id: 1, role: 'assistant' as const, content: 'abcdefgh\nLAST', trace_run_id: 'run', session_id: 'chat' };
    setActivityHistoryAnswer(panel, { kind: 'saved', message });
    panel.offset = Number.MAX_SAFE_INTEGER;
    assert.ok(renderActivityHistory(panel, 8, 7).join('\n').includes('LAST'));
    assert.equal(activityHistoryScrollLimit(panel, 4, 5), 2);
    assert.equal(activityHistoryScrollLimit(panel, 8, 5), 1);
    setActivityHistoryAnswer(panel, { kind: 'saved', message: { ...message, content: 'replacement' } });
    assert.match(renderActivityHistory(panel, 80, 10).join('\n'), /replacement/);
    panel.runs.push({ id: 'other', messageId: null, status: 'done', startedAt: 2 });
    assert.equal(moveActivityTurn(panel, 1), true);
    assert.equal(panel.answerView, false); assert.deepEqual(panel.answer, { kind: 'unloaded' });
    assert.equal(panel.originalScope, null);
    assert.doesNotMatch(renderActivityHistory(panel, 80, 10).join('\n'), /replacement/);
});

test('incremental viewport matches independent hand-counted grapheme/control rows at narrow widths', () => {
    const text = 'A\x1b]52;c;SECRET\x07👩‍💻é\r\n한\tZ\n';
    const expected = ['A👩‍💻', 'é', '한 ', '   ', 'Z', ''];
    const page = sliceActivityAnswerViewport(text, 3, 1, 3);
    assert.equal(page.totalRows, expected.length);
    assert.deepEqual(page.rows, expected.slice(1, 4));
    assert.deepEqual(sliceActivityAnswerViewport('👩‍💻X', 1, 0, 2).rows, ['?', 'X']);
    assert.deepEqual(sliceActivityAnswerViewport('visible\x1b]52;c;SECRET', 80, 0, 2).rows, ['visible']);
    for (let split = 1; split < text.length; split++) {
        const accumulated = text.slice(0, split) + text.slice(split);
        assert.deepEqual(sliceActivityAnswerViewport(accumulated, 3, 1, 3), page);
    }
    const panel = retained(); panel.answerView = true;
    setActivityHistoryAnswer(panel, { kind: 'saved', message: {
        id: 1, role: 'assistant', content: text, trace_run_id: 'run', session_id: 'chat',
    } });
    for (const width of [1, 2, 7, 20, 30, 80]) for (const height of [1, 2, 5, 14]) {
        const rows = renderActivityHistory(panel, width, height);
        assert.ok(rows.length <= height);
        assert.doesNotMatch(rows.join('\n'), /SECRET|\x1b/);
    }
    assert.match(renderActivityHistory(panel, 30, 14).join('\n'), /A answer/);
});
