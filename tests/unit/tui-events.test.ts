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

test('runtime normalization rejects malformed versions and preserves canonical flat identities', () => {
    const raw = { type: 'agent_runtime', version: 1, sessionId: 'jaw-chat', scope: 'local:jaw-chat',
        runId: 'trace-run', turnId: 'turn', seq: 7, kind: 'message', itemId: 'work',
        phase: 'commentary', operation: 'replace', text: '확인 중', parentItemId: 'parent' };
    const parsed = normalizeTuiWsEvent(raw);
    assert.equal(parsed.kind, 'runtime');
    if (parsed.kind === 'runtime') {
        const { type: _type, ...expected } = raw;
        assert.deepEqual(parsed.event, expected);
    }
    for (const patch of [{ version: 2 }, { seq: 0 }, { scope: '' }, { phase: 'guess' }]) {
        assert.equal(normalizeTuiWsEvent({ ...raw, ...patch }).kind, 'runtime-invalid');
    }
});

test('runtime gaps are identity notices without fabricated event sequence', () => {
    const raw = { type: 'agent_runtime_gap', runId: 'run', sessionId: 'chat', scope: 'local:chat',
        reason: 'projection_degraded' };
    const parsed = normalizeTuiWsEvent(raw);
    assert.deepEqual(parsed, { kind: 'runtime-gap', runId: 'run', sessionId: 'chat', scope: 'local:chat' });
    assert.equal(normalizeTuiWsEvent({ ...raw, sessionId: '' }).kind, 'ignore');
    assert.equal(normalizeTuiWsEvent({ ...raw, reason: 'untrusted instruction' }).kind, 'ignore');
    for (const field of ['runId', 'sessionId', 'scope']) {
        for (const value of [undefined, null, 7, {}, '', 'x'.repeat(241)]) {
            assert.equal(normalizeTuiWsEvent({ ...raw, [field]: value }).kind, 'ignore', field);
        }
        assert.equal(normalizeTuiWsEvent({ ...raw, [field]: 'x'.repeat(240) }).kind, 'runtime-gap');
    }
});
