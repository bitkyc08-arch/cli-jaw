import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromAcpUpdate } from '../src/agent/events.ts';

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
    assert.deepEqual(call, { tool: { icon: '🔧', label: 'Read', toolType: 'tool', detail: '', stepRef: 'acp:tool:Read' } });

    const updateByName = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'tool_call_update',
            name: 'Read',
            id: 'tool-1',
        },
    });
    assert.deepEqual(updateByName, { tool: { icon: '✅', label: 'Read', toolType: 'tool', stepRef: 'acp:tool:Read', status: 'done' } });

    const updateById = extractFromAcpUpdate({
        update: {
            sessionUpdate: 'tool_call_update',
            id: 'tool-2',
        },
    });
    assert.deepEqual(updateById, { tool: { icon: '✅', label: 'tool-2', toolType: 'tool', stepRef: 'acp:tool:tool-2', status: 'done' } });
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
