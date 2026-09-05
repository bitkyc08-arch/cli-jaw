import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendActivityAnswer } from '../../src/cli/tui/activity-answer.js';
import { createTranscriptState } from '../../src/cli/tui/transcript.js';
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
