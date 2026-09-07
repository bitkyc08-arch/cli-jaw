import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendActivityAnswer, writeActivityAnswer } from '../../src/cli/tui/activity-answer.js';
import { createTranscriptState } from '../../src/cli/tui/transcript.js';
import { renderTranscriptItem } from '../../bin/commands/tui/fullscreen-mode.js';
import { Viewport } from '../../src/cli/tui/render/viewport.js';

test('saved answer owns exact long bytes independently of a bounded journal preview', () => {
    const state = createTranscriptState();
    const finalText = 'a'.repeat(33000) + ' FINAL_TAIL';
    appendActivityAnswer(state, 'run', { status: 'done', finalText }, 'saved');
    assert.equal(appendActivityAnswer(state, 'run', { finalText: '[redacted]' }, 'compatibility'), false);
    assert.equal(state.items.length, 1);
    assert.match(renderTranscriptItem(state.items[0]!, 80).join('\n'), /FINAL_TAIL/);
});

test('null, empty and whitespace have distinct receipts; saved wins in either delivery order', () => {
    const state = createTranscriptState();
    for (const finalText of [null, '', ' \n\t']) appendActivityAnswer(state, JSON.stringify(finalText), { finalText }, 'saved');
    assert.deepEqual(state.items.map(i => i.type === 'assistant' ? [i.activityFinality, i.text] : null),
        [['absent', ''], ['present', ''], ['present', ' \n\t']]);
    for (const first of ['compatibility', 'saved'] as const) {
        const t = createTranscriptState();
        appendActivityAnswer(t, 'r', { finalText: first === 'saved' ? ' \n' : '' }, first);
        appendActivityAnswer(t, 'r', { finalText: ' \n' }, 'saved');
        appendActivityAnswer(t, 'r', { finalText: 'late wrong text' }, 'compatibility');
        assert.equal(t.items.length, 1);
        assert.equal(t.items[0]?.type === 'assistant' && t.items[0].text, ' \n');
    }
});

test('equal saved digest upgrades provenance without resurrecting released content', () => {
    const state = createTranscriptState();
    appendActivityAnswer(state, 'r', { finalText: 'original' }, 'compatibility');
    const row = state.items[0]!;
    assert.ok(row.type === 'assistant');
    row.activityReleased = true; row.text = '';
    assert.equal(appendActivityAnswer(state, 'r', { finalText: 'original' }, 'saved'), false);
    assert.equal(row.text, ''); assert.equal(row.activitySource, 'saved');
    assert.equal(state.items.length, 1);
});

test('irreversible different delivery is labeled Updated answer exactly once', () => {
    const state = createTranscriptState(); let output = '';
    const write = (text: string) => { output += text; };
    appendActivityAnswer(state, 'r', { finalText: 'compatibility' }, 'compatibility');
    writeActivityAnswer(state, 'r', 80, write);
    appendActivityAnswer(state, 'r', { finalText: 'saved exact' }, 'saved');
    writeActivityAnswer(state, 'r', 80, write);
    appendActivityAnswer(state, 'r', { finalText: 'saved exact' }, 'saved');
    writeActivityAnswer(state, 'r', 80, write);
    assert.equal(output.match(/Updated answer/g)?.length, 1);
    assert.match(output, /saved exact/);
});

test('provider terminal controls are display-only sanitized and prelude cannot swallow final', () => {
    const state = createTranscriptState(); const finalText = '\x1b[2J한글\x1b]52;c;SECRET\x07answer';
    appendActivityAnswer(state, 'r', { finalText, status: 'error' }, 'saved');
    const row = state.items[0]!;
    const rendered = renderTranscriptItem(row, 80).join('\n');
    assert.doesNotMatch(rendered, /\x1b|SECRET/); assert.match(rendered, /Partial answer/);
    assert.equal(row.type === 'assistant' && row.text, finalText);
    const viewport = new Viewport();
    viewport.setPrelude(Array.from({ length: 30 }, () => 'welcome'));
    viewport.setItems(state.items, item => renderTranscriptItem(item, 80), 14);
    assert.equal(viewport.peekStableCommitRows(14, state.items.length), null);
    assert.equal(viewport.currentFrontier().itemIndex, 0);
});
