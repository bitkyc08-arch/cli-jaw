import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTuiWsEvent } from '../../src/cli/tui/events.ts';

test('normalizeTuiWsEvent maps assistant output and thinking flag', () => {
    assert.deepEqual(
        normalizeTuiWsEvent({ type: 'agent_output', text: 'hello', thinking: true, agentId: 'main' }),
        { kind: 'assistant-output', text: 'hello', thinking: true, agentId: 'main' },
    );
    assert.deepEqual(
        normalizeTuiWsEvent({ type: 'agent_chunk', text: 'hi' }),
        { kind: 'assistant-output', text: 'hi', thinking: false },
    );
});

test('normalizeTuiWsEvent maps agent_done with raw object', () => {
    const raw = { type: 'agent_done', text: 'final', agentId: 'main', stopReason: 'completed' };
    const event = normalizeTuiWsEvent(raw);
    assert.equal(event.kind, 'agent-done');
    if (event.kind === 'agent-done') {
        assert.equal(event.text, 'final');
        assert.equal(event.agentId, 'main');
        assert.deepEqual(event.toolLog, []);
        assert.equal(event.raw, raw);
    }
});

test('normalizeTuiWsEvent bounds and maps agent_done toolLog entries', () => {
    const event = normalizeTuiWsEvent({
        type: 'agent_done',
        text: 'final',
        toolLog: [
            { icon: '🔧', label: 'Bash', detail: 'npm test', status: 'done', stepRef: 's1', agentId: 'main', toolType: 'bash' },
            { tool: 'Read', output: 'src/a.ts', status: 'error', id: 's2' },
            { icon: 'bad' },
        ],
    });

    assert.equal(event.kind, 'agent-done');
    if (event.kind === 'agent-done') {
        assert.deepEqual(event.toolLog, [
            { icon: '🔧', label: 'Bash', detail: 'npm test', status: 'done', agentId: 'main', stepRef: 's1', toolType: 'bash' },
            { icon: '•', label: 'Read', detail: 'src/a.ts', status: 'error', stepRef: 's2' },
        ]);
    }
});

test('normalizeTuiWsEvent normalizes tool status and preserves DTO-only toolType', () => {
    assert.deepEqual(
        normalizeTuiWsEvent({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'npm test', status: 'done', stepRef: 's1', toolType: 'bash' }),
        { kind: 'agent-tool', icon: '🔧', label: 'Bash', detail: 'npm test', status: 'done', stepRef: 's1', toolType: 'bash' },
    );
    assert.deepEqual(
        normalizeTuiWsEvent({ type: 'agent_tool', icon: '🔧', label: 'Read', status: 'unknown' }),
        { kind: 'agent-tool', icon: '🔧', label: 'Read', detail: '', status: 'running' },
    );
    assert.equal(normalizeTuiWsEvent({ type: 'agent_tool', icon: '🔧' }).kind, 'ignore');
});

test('normalizeTuiWsEvent maps status, queue, fallback, and worker warnings', () => {
    assert.deepEqual(
        normalizeTuiWsEvent({ type: 'agent_status', status: 'running', agentName: 'main' }),
        { kind: 'agent-status', status: 'running', agentName: 'main' },
    );
    const queue = normalizeTuiWsEvent({ type: 'queue_update', pending: 2 });
    assert.equal(queue.kind, 'queue-update');
    if (queue.kind === 'queue-update') assert.equal(queue.pending, 2);
    assert.deepEqual(
        normalizeTuiWsEvent({ type: 'agent_fallback', from: 'a', to: 'b' }),
        { kind: 'agent-fallback', from: 'a', to: 'b' },
    );
    assert.deepEqual(
        normalizeTuiWsEvent({ type: 'worker_timeout', agentId: 'w1' }),
        { kind: 'worker-warning', type: 'worker_timeout', agentId: 'w1' },
    );
});

test('normalizeTuiWsEvent keeps unknown events raw', () => {
    const raw = { type: 'system_notice', text: 'note' };
    const event = normalizeTuiWsEvent(raw);
    assert.equal(event.kind, 'raw');
    if (event.kind === 'raw') assert.equal(event.raw, raw);
    assert.equal(normalizeTuiWsEvent('bad').kind, 'ignore');
});
