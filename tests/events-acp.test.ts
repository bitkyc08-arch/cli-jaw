import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromAcpSubagent, extractFromAcpUpdate } from '../src/agent/events.ts';

test('extractFromAcpUpdate keeps full thought detail while previewing the label', () => {
    const longThought = 'a'.repeat(80);
    const out = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'agent_thought_chunk',
            content: longThought,
        },
    });
    assert.equal(out.tool.icon, '💭');
    assert.equal(out.tool.label.endsWith('…'), true);
    assert.equal(out.tool.label.length, 60);
    assert.equal(out.tool.toolType, 'thinking');
    assert.equal(out.tool.detail, longThought);
});

test('extractFromAcpUpdate handles tool_call and tool_call_update fallback', () => {
    const call = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'tool_call',
            name: 'Read',
        },
    });
    assert.deepEqual(call, { tool: { icon: '🔧', label: 'Read', toolType: 'tool', detail: '', stepRef: 'acp:callid:Read' } });

    // tool_call_update with completed status
    const updateByName = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'tool_call_update',
            name: 'Read',
            id: 'tool-1',
            status: 'completed',
        },
    });
    assert.deepEqual(updateByName, { tool: { icon: '✅', label: 'Read', toolType: 'tool', stepRef: 'acp:callid:tool-1', status: 'done' } });

    // tool_call_update with failed status
    const updateFailed = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'tool_call_update',
            name: 'Write',
            id: 'tool-3',
            status: 'failed',
        },
    });
    assert.deepEqual(updateFailed, { tool: { icon: '❌', label: 'Write', toolType: 'tool', stepRef: 'acp:callid:tool-3', status: 'error' } });

    // tool_call_update by id only (no name, no status → defaults to ❔/unknown)
    const updateById = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'tool_call_update',
            id: 'tool-2',
        },
    });
    assert.deepEqual(updateById, { tool: { icon: '❔', label: 'tool-2', toolType: 'tool', stepRef: 'acp:callid:tool-2', status: 'unknown' } });
});

test('extractFromAcpUpdate handles agent_message_chunk content shapes', () => {
    const asString = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'agent_message_chunk',
            content: 'hello',
        },
    });
    assert.deepEqual(asString, { text: 'hello' });

    const asArray = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'agent_message_chunk',
            content: [
                { type: 'text', text: 'A' },
                { type: 'image', image: 'ignored' },
                { type: 'text', text: 'B' },
            ],
        },
    });
    assert.deepEqual(asArray, { text: 'AB' });

    const asObject = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'single' },
        },
    });
    assert.deepEqual(asObject, { text: 'single' });
});

test('extractFromAcpUpdate handles plan and unknown update types', () => {
    const plan = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'plan',
        },
    });
    assert.deepEqual(plan, { tool: { icon: '📝', label: 'planning...', toolType: 'thinking' } });

    assert.equal(extractFromAcpUpdate({ update: { sessionUpdate: 'unknown_type' } }), null);
    assert.equal(extractFromAcpUpdate({}), null);
});

test('extractFromAcpSubagent maps Copilot subagent lifecycle events', () => {
    const started = extractFromAcpSubagent({
        type: 'subagent.started',
        data: {
            toolCallId: 'tool-1',
            agentName: 'general',
            agentDisplayName: 'General Agent',
            agentDescription: 'General helper',
        },
    });
    assert.deepEqual(started, {
        tool: {
            icon: '🤖',
            label: 'subagent: General Agent',
            toolType: 'subagent',
            stepRef: 'acp:subagent:tool-1',
            status: 'running',
            detail: 'General helper',
        },
    });

    const completed = extractFromAcpSubagent({
        type: 'subagent.completed',
        data: { toolCallId: 'tool-1', agentName: 'general', agentDisplayName: 'General Agent' },
    });
    assert.equal(completed.tool.icon, '✅');
    assert.equal(completed.tool.stepRef, 'acp:subagent:tool-1');
    assert.equal(completed.tool.toolType, 'subagent');
    assert.equal(completed.tool.status, 'done');

    const selected = extractFromAcpSubagent({
        type: 'subagent.selected',
        data: { agentName: 'general', agentDisplayName: 'General Agent', tools: null },
    });
    assert.deepEqual(selected, {
        tool: {
            icon: '🎯',
            label: 'selected: General Agent',
            toolType: 'subagent',
            stepRef: 'acp:subagent:selection:general',
            status: 'done',
            detail: 'tools: all',
        },
    });

    assert.equal(extractFromAcpSubagent({ type: 'other.event' }), null);
});

test('extractFromAcpUpdate maps observed Copilot ACP task tool_call wire as subagent', () => {
    const ctx = { acpSubagentToolCallIds: new Set() };
    const started = extractFromAcpUpdate({
        sessionId: 'session-1',
        update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'toolu_1',
            title: 'Reply DONE',
            kind: 'other',
            status: 'pending',
            rawInput: {
                agent_type: 'task',
                description: 'Reply DONE',
                name: 'echo-done',
                prompt: 'Reply with exactly the single word: DONE',
            },
        },
    }, ctx);

    assert.equal(started.tool.icon, '🤖');
    assert.equal(started.tool.label, 'subagent: Reply DONE');
    assert.equal(started.tool.toolType, 'subagent');
    assert.equal(started.tool.stepRef, 'acp:callid:toolu_1');
    assert.equal(started.tool.status, 'running');
    assert.equal(ctx.acpSubagentToolCallIds.has('toolu_1'), true);

    const completed = extractFromAcpUpdate({
        sessionId: 'session-1',
        update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'DONE' } }],
        },
    }, ctx);
    assert.equal(completed.tool.icon, '✅');
    assert.equal(completed.tool.label, 'subagent: Reply DONE');
    assert.equal(completed.tool.toolType, 'subagent');
    assert.equal(completed.tool.stepRef, 'acp:callid:toolu_1');
    assert.equal(completed.tool.status, 'done');
});
