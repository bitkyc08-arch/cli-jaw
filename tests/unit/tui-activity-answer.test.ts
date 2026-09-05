import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendActivityAnswer, writeActivityAnswer } from '../../src/cli/tui/activity-answer.js';
import { createTranscriptState, appendActivityFallbackPreview, settleActivityFallbackPreviews } from '../../src/cli/tui/transcript.js';
import { activityTerminalWidth } from '../../src/cli/tui/activity-terminal-text.js';
import { renderTranscriptItem } from '../../bin/commands/tui/fullscreen-mode.js';
import { Viewport } from '../../src/cli/tui/render/viewport.js';

test('full Activity answer is owned once outside the bounded preview', () => {
    const transcript = createTranscriptState();
    const finalText = 'a'.repeat(33_000) + ' FINAL_TAIL_SENTINEL';
    assert.equal(appendActivityAnswer(transcript, 'run-key', { status: 'done', finalText }), true);
    assert.equal(appendActivityAnswer(transcript, 'run-key', { status: 'done', finalText }), false);
    assert.equal(transcript.items.length, 1);
    const answer = transcript.items[0]!;
    assert.equal(answer.type, 'assistant');
    if (answer.type === 'assistant') assert.equal(answer.text, finalText);
    assert.match(renderTranscriptItem(answer, 80).join('\n'), /FINAL_TAIL_SENTINEL/);
});

test('null and empty answers have distinct receipts and no inferred rendered answer', () => {
    const transcript = createTranscriptState();
    appendActivityAnswer(transcript, 'absent', { status: 'stopped', finalText: null });
    appendActivityAnswer(transcript, 'empty', { status: 'done', finalText: '' });
    assert.deepEqual(transcript.items.map(item => item.type === 'assistant' ? item.activityFinality : null), ['absent', 'present']);
    for (const item of transcript.items) assert.deepEqual(renderTranscriptItem(item, 80), []);
});

test('native answer rendering treats provider VT sequences as text boundary input', () => {
    const transcript = createTranscriptState();
    appendActivityAnswer(transcript, 'run', { status: 'error', finalText: '\x1b[2J한글\x1b]52;c;secret\x07answer' });
    const rendered = renderTranscriptItem(transcript.items[0]!, 80).join('\n');
    assert.match(rendered, /Partial answer/);
    assert.match(rendered, /한글answer/);
    assert.doesNotMatch(rendered, /\x1b|secret/);
});

test('uncommitted welcome rows cannot be mistaken for committed answer items', () => {
    const transcript = createTranscriptState();
    appendActivityAnswer(transcript, 'run', { status: 'done', finalText: 'visible final' });
    const viewport = new Viewport();
    viewport.setPrelude(Array.from({ length: 30 }, (_, i) => `welcome-${i}`));
    viewport.setItems(transcript.items, () => ['Answer', 'visible final'], 14);
    assert.equal(viewport.peekStableCommitRows(14, transcript.items.length), null);
    assert.deepEqual(viewport.currentFrontier(), { preludeCommitted: false, itemIndex: 0 });
    assert.ok(viewport.composeRegion({ x: 1, y: 1, width: 80, height: 14 }).includes('visible final'));
});

test('original print final replaces a different uncommitted canonical body and invalidates answer status', () => {
    const transcript = createTranscriptState();
    appendActivityAnswer(transcript, 'run', { status: 'done', finalText: '[redacted]' });
    appendActivityAnswer(transcript, 'run', { finalText: 'original bytes\r\n' }, 'print');
    assert.equal(transcript.items.length, 1);
    assert.equal(transcript.items[0]?.type === 'assistant' && transcript.items[0].text, 'original bytes\r\n');
    const viewport = new Viewport();
    viewport.setItems(transcript.items, item => renderTranscriptItem(item, 80), 10);
    const answer = transcript.items[0]!;
    assert.ok(answer.type === 'assistant');
    answer.activityStatus = 'error';
    viewport.setItems(transcript.items, item => renderTranscriptItem(item, 80), 10);
    assert.match(viewport.composeRegion({ x: 1, y: 1, width: 80, height: 10 }).join('\n'), /Partial answer/);
});

test('different print bytes after line delivery get one explicit correction; equal bytes do not repeat', () => {
    for (const original of ['original full bytes', '']) {
        const transcript = createTranscriptState();
        let output = '';
        const write = (text: string) => { output += text; };
        appendActivityAnswer(transcript, 'run', { status: 'done', finalText: 'canonical preview' });
        writeActivityAnswer(transcript, 'run', 80, write);
        appendActivityAnswer(transcript, 'run', { finalText: original }, 'print');
        writeActivityAnswer(transcript, 'run', 80, write);
        appendActivityAnswer(transcript, 'run', { finalText: original }, 'print');
        writeActivityAnswer(transcript, 'run', 80, write);
        assert.equal(output.match(/Updated answer/g)?.length, 1);
        assert.match(output, original ? /original full bytes/ : /final answer is empty/);
        assert.equal(transcript.items.length, 1);
    }
});

test('fullscreen gap previews keep split provider VT inert and narrow rows bounded', () => {
    for (const thinking of [false, true]) {
        const transcript = createTranscriptState();
        const preview = appendActivityFallbackPreview(transcript, 'run', 'visible\x1b]52;c;SECRET', { thinking })!;
        assert.doesNotMatch(renderTranscriptItem(preview.item, 80).join('\n'), /SECRET|\x1b/);
        appendActivityFallbackPreview(transcript, 'run', '\x07\x1b[2J한글 👩‍💻\n'.repeat(30), { thinking });
        for (const width of [1, 2, 20, 80]) {
            const rows = renderTranscriptItem(preview.item, width);
            assert.doesNotMatch(rows.join('\n'), /SECRET|\x1b|\x07/);
            assert.ok(rows.every(row => activityTerminalWidth(row) <= width));
        }
        settleActivityFallbackPreviews(transcript, 'run');
        assert.deepEqual(renderTranscriptItem(preview.item, 80), []);
    }
});
