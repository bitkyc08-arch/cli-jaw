import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTranscriptState,
    appendUserItem,
    startAssistantItem,
    appendToActiveAssistant,
    finalizeAssistant,
    appendStatusItem,
    clearEphemeralStatus,
} from '../../src/cli/tui/transcript.ts';

test('appendUserItem adds user transcript entry', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hello', 'hello');
    assert.equal(state.items.length, 1);
    const item = state.items[0]!;
    assert.equal(item.type, 'user');
    if (item.type === 'user') {
        assert.equal(item.displayText, 'hello');
        assert.equal(item.submitText, 'hello');
    }
});

test('assistant chunk flow: start → append → finalize', () => {
    const state = createTranscriptState();
    startAssistantItem(state);
    assert.equal(state.items.length, 1);
    const item = state.items[0]!;
    assert.equal(item.type, 'assistant');
    if (item.type === 'assistant') {
        assert.equal(item.streaming, true);
        assert.equal(item.text, '');
    }

    appendToActiveAssistant(state, 'Hello ');
    appendToActiveAssistant(state, 'world');
    if (item.type === 'assistant') {
        assert.equal(item.text, 'Hello world');
        assert.equal(item.streaming, true);
    }

    finalizeAssistant(state);
    if (item.type === 'assistant') {
        assert.equal(item.streaming, false);
    }
});

test('appendToActiveAssistant returns false when no active assistant', () => {
    const state = createTranscriptState();
    assert.equal(appendToActiveAssistant(state, 'chunk'), false);
    appendUserItem(state, 'hi', 'hi');
    assert.equal(appendToActiveAssistant(state, 'chunk'), false);
});

test('appendToActiveAssistant returns false after finalize', () => {
    const state = createTranscriptState();
    startAssistantItem(state);
    finalizeAssistant(state);
    assert.equal(appendToActiveAssistant(state, 'chunk'), false);
});

test('agent_done with text but no prior chunks', () => {
    const state = createTranscriptState();
    startAssistantItem(state);
    appendToActiveAssistant(state, 'full response');
    finalizeAssistant(state);
    const item = state.items[0]!;
    if (item.type === 'assistant') {
        assert.equal(item.text, 'full response');
        assert.equal(item.streaming, false);
    }
});

test('ephemeral status replaces previous status', () => {
    const state = createTranscriptState();
    appendStatusItem(state, 'working...');
    assert.equal(state.items.length, 1);
    appendStatusItem(state, 'tool: read');
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]!.type, 'status');
    if (state.items[0]!.type === 'status') {
        assert.equal(state.items[0]!.text, 'tool: read');
    }
});

test('clearEphemeralStatus removes trailing status', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hi', 'hi');
    appendStatusItem(state, 'working...');
    assert.equal(state.items.length, 2);
    clearEphemeralStatus(state);
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]!.type, 'user');
});

test('clearEphemeralStatus does nothing when last item is not status', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hi', 'hi');
    clearEphemeralStatus(state);
    assert.equal(state.items.length, 1);
});

test('full conversation flow', () => {
    const state = createTranscriptState();
    // User sends
    appendUserItem(state, 'hello', 'hello');
    // Status updates
    appendStatusItem(state, 'agent working...');
    appendStatusItem(state, 'read file.ts');
    // Assistant starts
    clearEphemeralStatus(state);
    startAssistantItem(state);
    appendToActiveAssistant(state, 'Hi! ');
    appendToActiveAssistant(state, 'How can I help?');
    finalizeAssistant(state);

    assert.equal(state.items.length, 2);
    assert.equal(state.items[0]!.type, 'user');
    assert.equal(state.items[1]!.type, 'assistant');
    if (state.items[1]!.type === 'assistant') {
        assert.equal(state.items[1]!.text, 'Hi! How can I help?');
        assert.equal(state.items[1]!.streaming, false);
    }
});

test('user item with paste (display differs from submit)', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'fix this [Pasted text #1 +5 lines]', 'fix this\nline1\nline2\nline3\nline4\nline5');
    const item = state.items[0]!;
    if (item.type === 'user') {
        assert.equal(item.displayText, 'fix this [Pasted text #1 +5 lines]');
        assert.equal(item.submitText.includes('\n'), true);
    }
});
