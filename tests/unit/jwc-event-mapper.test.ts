import test from 'node:test';
import assert from 'node:assert/strict';
import { addBroadcastListener, clearAllBroadcastListeners } from '../../src/core/bus.ts';
import { beginLiveRun, clearLiveRun, getLiveRun, appendLiveRunText } from '../../src/agent/live-run-state.ts';
import { mapAgentEventToBus } from '../../src/agent/jwc-event-mapper.ts';

test('jwc agent_end emits missing final suffix from assistant messages', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));

    const scope = 'unit-jwc-final-suffix';
    beginLiveRun(scope, 'jwc');
    appendLiveRunText(scope, 'intro\n');

    try {
        mapAgentEventToBus({
            type: 'agent_end',
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'run tools' }] },
                { role: 'assistant', content: [{ type: 'text', text: 'intro\nfinal summary' }] },
            ],
        }, { cwd: '/tmp/unit', sessionId: 's1', liveScope: scope });

        const output = events.find((event) => event.type === 'agent_output');
        assert.equal(output?.data['text'], 'final summary');
        assert.equal(getLiveRun(scope).text, 'intro\nfinal summary');

        const done = events.find((event) => event.type === 'agent_done');
        assert.equal(done?.data['text'], 'intro\nfinal summary');
    } finally {
        clearLiveRun(scope);
        clearAllBroadcastListeners();
    }
});

test('jwc agent_end does not duplicate already streamed final text', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));

    const scope = 'unit-jwc-no-duplicate';
    beginLiveRun(scope, 'jwc');
    appendLiveRunText(scope, 'complete');

    try {
        mapAgentEventToBus({
            type: 'agent_end',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'complete' }] }],
        }, { cwd: '/tmp/unit', sessionId: 's1', liveScope: scope });

        assert.equal(events.some((event) => event.type === 'agent_output'), false);
        assert.equal(getLiveRun(scope).text, 'complete');
    } finally {
        clearLiveRun(scope);
        clearAllBroadcastListeners();
    }
});

// ─── WP4b: agent_tool carries the authoritative run start ───

test('jwc tool broadcasts carry startedAt from the context runStartedAt', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));

    const startedAt = 1_700_000_000_000;
    const ctx = { cwd: '/tmp/unit', sessionId: 's1', runStartedAt: startedAt };
    try {
        mapAgentEventToBus({
            type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'ls' },
        }, ctx);
        mapAgentEventToBus({
            type: 'tool_execution_update', toolCallId: 'tc1', toolName: 'bash', args: { command: 'ls' },
        }, ctx);
        mapAgentEventToBus({
            type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash', isError: false,
        }, ctx);

        const tools = events.filter((event) => event.type === 'agent_tool');
        assert.equal(tools.length, 3);
        for (const tool of tools) {
            assert.equal(tool.data['startedAt'], startedAt, 'every agent_tool must carry the run start');
        }
        assert.equal(tools[2]?.data['status'], 'done');
    } finally {
        clearAllBroadcastListeners();
    }
});
