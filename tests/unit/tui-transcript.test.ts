import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTranscriptState,
    appendUserItem,
    startAssistantItem,
    appendToActiveAssistant,
    appendAssistantTurnText,
    finalizeAssistant,
    finalizeStreamingAssistants,
    assistantTextSinceLastUser,
    appendThinkingTurnText,
    appendStatusItem,
    appendCommandItem,
    clearEphemeralStatus,
    appendToolItem,
    commitThinkingItemOnce,
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

test('appendAssistantTurnText starts a new assistant after intervening tool rows', async () => {
    const { appendToolItem } = await import('../../src/cli/tui/transcript.ts');
    const state = createTranscriptState();
    startAssistantItem(state);
    appendToActiveAssistant(state, 'before tools\n');
    appendToolItem(state, '🔧 Bash echo 1');

    assert.equal(appendAssistantTurnText(state, 'after tools', 'main'), true);
    assert.equal(state.items.length, 3);
    assert.equal(state.items[2]!.type, 'assistant');
    if (state.items[2]!.type === 'assistant') {
        assert.equal(state.items[2]!.text, 'after tools');
        assert.equal(state.items[2]!.streaming, true);
    }
});

test('assistantTextSinceLastUser joins split assistant text around tools', async () => {
    const state = createTranscriptState();
    appendUserItem(state, 'run tools', 'run tools');
    startAssistantItem(state);
    appendToActiveAssistant(state, 'a');
    appendToolItem(state, '🔧 Bash echo 1');
    appendAssistantTurnText(state, 'c');

    assert.equal(assistantTextSinceLastUser(state), 'ac');
});

test('finalizeStreamingAssistants finalizes assistant rows split by tools', async () => {
    const state = createTranscriptState();
    startAssistantItem(state);
    appendToActiveAssistant(state, 'a');
    appendToolItem(state, '🔧 Bash echo 1');
    appendAssistantTurnText(state, 'c');

    assert.equal(finalizeStreamingAssistants(state), true);
    const assistantRows = state.items.filter((item) => item.type === 'assistant');
    assert.equal(assistantRows.length, 2);
    assert.ok(assistantRows.every((item) => item.type === 'assistant' && item.streaming === false));
});

test('thinking rows do not count as assistant final text', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hello', 'hello');
    appendThinkingTurnText(state, 'internal reasoning\nstep two', 'main');

    assert.equal(assistantTextSinceLastUser(state), '');
    assert.equal(finalizeStreamingAssistants(state), true);
    const item = state.items[1]!;
    assert.equal(item.type, 'thinking');
    if (item.type === 'thinking') {
        assert.equal(item.streaming, false);
        assert.equal(item.collapsed, true);
    }
});

test('assistant final text starts after thinking rows', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hello', 'hello');
    appendThinkingTurnText(state, 'internal reasoning', 'main');
    appendAssistantTurnText(state, 'Hello!', 'main');

    assert.equal(assistantTextSinceLastUser(state), 'Hello!');
    assert.equal(state.items.map((item) => item.type).join(','), 'user,thinking,assistant');
});

test('thinking can appear between same-turn tool rows', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'run tools', 'run tools');
    appendToolItem(state, 'Bash echo 1', { status: 'done', stepRef: 'tool-1' });
    appendThinkingTurnText(state, 'Planning tool calls', 'main');
    appendThinkingTurnText(state, '\nExecuting tool calls', 'main');
    appendToolItem(state, 'Read file', { status: 'done', stepRef: 'tool-2' });

    assert.equal(state.items.map((item) => item.type).join(','), 'user,tool,thinking,tool');
    const thinking = state.items[2]!;
    assert.equal(thinking.type, 'thinking');
    if (thinking.type === 'thinking') {
        assert.equal(thinking.text, 'Planning tool calls\nExecuting tool calls');
        assert.equal(thinking.streaming, true);
    }
});

test('new thinking after a tool does not merge into an earlier thinking block', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'run tools', 'run tools');
    appendThinkingTurnText(state, 'first thought', 'main');
    appendToolItem(state, 'Bash echo 1', { status: 'done', stepRef: 'tool-1' });
    appendThinkingTurnText(state, 'second thought', 'main');

    assert.equal(state.items.map((item) => item.type).join(','), 'user,thinking,tool,thinking');
    const first = state.items[1]!;
    const second = state.items[3]!;
    assert.equal(first.type, 'thinking');
    assert.equal(second.type, 'thinking');
    if (first.type === 'thinking' && second.type === 'thinking') {
        assert.equal(first.text, 'first thought');
        assert.equal(second.text, 'second thought');
    }
});

test('late thinking is inserted before same-turn final assistant text', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hello', 'hello');
    appendAssistantTurnText(state, 'Final answer', 'main');
    appendThinkingTurnText(state, 'Internal plan', 'main');

    assert.equal(state.items.map((item) => item.type).join(','), 'user,thinking,assistant');
});

test('late thinking chunks merge before same-turn final assistant text', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hello', 'hello');
    appendAssistantTurnText(state, 'Final answer', 'main');
    appendThinkingTurnText(state, 'Internal plan', 'main');
    appendThinkingTurnText(state, '\nCheck final wording', 'main');

    assert.equal(state.items.map((item) => item.type).join(','), 'user,thinking,assistant');
    const thinking = state.items[1]!;
    assert.equal(thinking.type, 'thinking');
    if (thinking.type === 'thinking') {
        assert.equal(thinking.text, 'Internal plan\nCheck final wording');
    }
});

test('toolLog thinking commits as collapsed transcript item between tool rows', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'run tools', 'run tools');
    appendToolItem(state, 'Bash echo 1', { status: 'done', stepRef: 'tool-1' });
    assert.equal(commitThinkingItemOnce(state, {
        icon: '•',
        label: 'Thinking',
        detail: 'Inspect bash output\nPlan the read step',
        status: 'done',
        stepRef: 'think-1',
        toolType: 'thinking',
    }), true);
    appendToolItem(state, 'Read file', { status: 'done', stepRef: 'tool-2' });

    assert.equal(state.items.map((item) => item.type).join(','), 'user,tool,thinking,tool');
    const thinking = state.items[2]!;
    assert.equal(thinking.type, 'thinking');
    if (thinking.type === 'thinking') {
        assert.equal(thinking.text, 'Inspect bash output\nPlan the read step');
        assert.equal(thinking.streaming, false);
        assert.equal(thinking.collapsed, true);
        assert.equal(thinking.stepRef, 'think-1');
    }
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

test('clearEphemeralStatus removes non-trailing status rows', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hi', 'hi');
    appendStatusItem(state, 'working...');
    appendAssistantTurnText(state, 'hello', 'main');

    assert.equal(state.items.map((item) => item.type).join(','), 'user,status,assistant');
    clearEphemeralStatus(state);
    assert.equal(state.items.map((item) => item.type).join(','), 'user,assistant');
});

test('clearEphemeralStatus does nothing when last item is not status', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hi', 'hi');
    clearEphemeralStatus(state);
    assert.equal(state.items.length, 1);
});

test('command feedback is durable and clears transient status rows', () => {
    const state = createTranscriptState();
    appendStatusItem(state, 'main thinking...');
    appendCommandItem(state, 'State → P', { commandName: 'orchestrate', ok: true });

    assert.equal(state.items.length, 1);
    const item = state.items[0]!;
    assert.equal(item.type, 'command');
    if (item.type === 'command') {
        assert.equal(item.text, 'State → P');
        assert.equal(item.commandName, 'orchestrate');
        assert.equal(item.ok, true);
    }
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

test('streaming thinking settles when answer text starts', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hello', 'hello');
    appendThinkingTurnText(state, 'Working through the problem', 'main');
    const thinkingBefore = state.items[1]!;
    assert.equal(thinkingBefore.type, 'thinking');
    if (thinkingBefore.type === 'thinking') assert.equal(thinkingBefore.streaming, true);

    appendAssistantTurnText(state, 'First answer token', 'main');

    assert.equal(state.items.map((item) => item.type).join(','), 'user,thinking,assistant');
    const thinking = state.items[1]!;
    assert.equal(thinking.type, 'thinking');
    if (thinking.type === 'thinking') {
        assert.equal(thinking.streaming, false, 'thinking must settle once the stream moves past it');
    }
    const assistant = state.items[2]!;
    assert.equal(assistant.type, 'assistant');
    if (assistant.type === 'assistant') assert.equal(assistant.streaming, true);
});

test('thinking after settle starts a new block instead of reopening the settled one', () => {
    const state = createTranscriptState();
    appendUserItem(state, 'hello', 'hello');
    appendThinkingTurnText(state, 'Plan A', 'main');
    appendAssistantTurnText(state, 'answer chunk', 'main');
    appendThinkingTurnText(state, 'Plan B', 'main');

    const thinkingItems = state.items.filter((item) => item.type === 'thinking');
    assert.equal(thinkingItems.length, 2);
    if (thinkingItems[0]!.type === 'thinking' && thinkingItems[1]!.type === 'thinking') {
        assert.equal(thinkingItems[0]!.text, 'Plan A');
        assert.equal(thinkingItems[0]!.streaming, false);
        assert.equal(thinkingItems[1]!.text, 'Plan B');
    }
});

test('answer text does not settle stepRef thinking rows owned by tool events', async () => {
    const state = createTranscriptState();
    appendUserItem(state, 'run', 'run');
    const { appendThinkingItem } = await import('../../src/cli/tui/transcript.ts');
    appendThinkingItem(state, 'tool-driven reasoning', { stepRef: 'think-1', streaming: true, collapsed: true });
    appendAssistantTurnText(state, 'answer', 'main');

    const stepThinking = state.items.find((item) => item.type === 'thinking' && item.stepRef === 'think-1');
    assert.ok(stepThinking);
    if (stepThinking && stepThinking.type === 'thinking') {
        assert.equal(stepThinking.streaming, true, 'stepRef thinking is finalized by its own tool-event lifecycle');
    }
});

test('streaming assistant settles when a tool row interrupts the segment', async () => {
    const state = createTranscriptState();
    appendUserItem(state, 'run', 'run');
    appendAssistantTurnText(state, 'running tools now', 'main');
    appendToolItem(state, '🔧 Bash pwd', { status: 'done', stepRef: 't-1' });

    const assistant = state.items[1]!;
    assert.equal(assistant.type, 'assistant');
    if (assistant.type === 'assistant') {
        assert.equal(assistant.streaming, false, 'tool event must settle the answer segment (no lingering cursor)');
    }

    assert.equal(appendAssistantTurnText(state, 'after tools', 'main'), true);
    const tail = state.items[state.items.length - 1]!;
    assert.equal(tail.type, 'assistant');
    if (tail.type === 'assistant') {
        assert.equal(tail.text, 'after tools');
        assert.equal(tail.streaming, true, 'post-tool text starts a fresh streaming segment');
    }
});

test('running live tool settles the streaming assistant tail too', async () => {
    const { upsertLiveToolItem } = await import('../../src/cli/tui/transcript.ts');
    const state = createTranscriptState();
    appendUserItem(state, 'run', 'run');
    appendAssistantTurnText(state, 'kicking off ten tools', 'main');
    upsertLiveToolItem(state, { icon: '🔧', label: 'pwd', detail: '', status: 'running', agentId: 'main', stepRef: 'live-1', toolType: 'tool' });

    const assistant = state.items[1]!;
    assert.equal(assistant.type, 'assistant');
    if (assistant.type === 'assistant') {
        assert.equal(assistant.streaming, false, 'cursor must not linger while tools run in the live lane');
    }
});
