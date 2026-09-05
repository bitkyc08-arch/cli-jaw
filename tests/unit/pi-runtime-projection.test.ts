import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiRpcRecord, type PiRuntimeEvent } from '../../src/agent/pi-runtime.ts';
// Recorders are injected here; module loading must not initialize shared SQLite.
let unexpectedDefaultWrites = 0;
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => {
    unexpectedDefaultWrites++; throw new Error('Pure projection test reached the default trace writer');
} } });
test.after(() => assert.equal(unexpectedDefaultWrites, 0));
const { PiProjection, parsePiActivityRecord } = await import('../../src/agent/runtime/pi-projection.ts');
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';
import { encodeRuntimeBody, decodeRuntimeBody } from '../../src/trace/runtime-body-codec.ts';
import { stringifyTraceValue } from '../../src/trace/redact.ts';

function harness() {
    const events: RuntimeEvent[] = [];
    const legacy: PiRuntimeEvent[] = [];
    const notices: string[] = [];
    let seq = 0, text = '';
    const state = new RuntimeProjection({ runId: 'run', sessionId: 'jaw-session',
        scope: 'mention-watch:separate-scope', turnId: 'run', audience: 'internal',
        parentItemId: 'trusted-jaw-parent' }, (context, body) => {
        const event: RuntimeEvent = { ...context, version: 1, seq: seq += 2, ...body };
        events.push(event);
        return event;
    }, reason => { notices.push(reason); });
    state.start('pi');
    const projection = new PiProjection(state);
    const accepted = (event: PiRuntimeEvent) => { projection.observe(event); legacy.push(event); };
    const feed = (raw: unknown) => {
        projection.observeRecord(raw);
        const parsed = parsePiRpcRecord(raw);
        if (parsed.sessionId) accepted({ kind: 'session', sessionId: parsed.sessionId });
        if (parsed.tool) accepted({ kind: 'tool', ...parsed.tool });
        if (parsed.thinking) accepted({ kind: 'thinking', text: parsed.thinking });
        if (parsed.text && !(parsed.done && text)) {
            text += parsed.text;
            accepted({ kind: 'text', text: parsed.text });
        }
    };
    return { state, events, legacy, notices, feed, text: () => text };
}

test('same-named Pi tools retain distinct IDs; output updates replace snapshots', () => {
    const h = harness();
    for (const toolCallId of ['call-one', 'call-two']) {
        h.feed({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command: 'pwd' } });
        h.feed({ type: 'tool_execution_update', toolCallId, toolName: 'bash',
            partialResult: { content: [{ type: 'text', text: 'a' }] } });
        h.feed({ type: 'tool_execution_update', toolCallId, toolName: 'bash',
            partialResult: { content: [{ type: 'text', text: 'ab' }] } });
        h.feed({ type: 'tool_execution_end', toolCallId, toolName: 'bash',
            result: { content: [{ type: 'text', text: 'abc' }] }, isError: toolCallId === 'call-two' });
    }
    const tools = h.events.filter(e => e.kind === 'tool');
    const ends = tools.filter(e => e.status !== 'running');
    assert.equal(new Set(tools.map(e => e.itemId)).size, 2);
    assert.deepEqual(ends.map(e => [e.name, e.status, e.output]), [['bash', 'done', 'abc'], ['bash', 'error', 'abc']]);
    assert.equal(h.legacy.filter(e => e.kind === 'tool').length, 2);
    assert.equal(h.text(), '');
    assert.ok(!JSON.stringify(h.events).includes('call-one'));
    assert.ok(h.events.every(e => e.sessionId === 'jaw-session' && e.scope !== e.sessionId && e.seq % 2 === 0));
});

test('Pi thinking is reasoning, final echo cannot duplicate accepted answer', () => {
    const h = harness();
    h.feed({ type: 'message_start', message: { role: 'assistant' } });
    h.feed({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'reason' } });
    h.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'answer' } });
    h.feed({ type: 'agent_end', sessionId: 'provider-session',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }] });
    assert.equal(h.text(), 'answer');
    assert.equal(h.events.filter(e => e.kind === 'message').length, 1);
    assert.equal(h.events.filter(e => e.kind === 'reasoning').length, 1);
    assert.equal(h.events.filter(e => e.kind === 'turn-end').length, 0);
    h.state.close({ kind: 'turn-end', status: 'done', finalText: 'policy answer' });
    h.state.close({ kind: 'turn-end', status: 'done', finalText: 'duplicate' });
    assert.deepEqual(h.events.filter(e => e.kind === 'turn-end').map(e => e.finalText), ['policy answer']);
});

test('result-only answer is accepted once and remains phase unknown', () => {
    const h = harness();
    const raw = { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'only result' }] }] };
    h.feed(raw);
    h.feed(raw);
    assert.deepEqual(h.events.filter(e => e.kind === 'message').map(e => [e.phase, e.text]), [['unknown', 'only result']]);
});

test('missing IDs never merge equal labels or use RPC correlation ID', () => {
    const h = harness();
    h.feed({ type: 'tool_execution_start', id: 42, toolName: 'bash' });
    h.feed({ type: 'tool_execution_start', id: 42, toolName: 'bash' });
    assert.equal(new Set(h.events.filter(e => e.kind === 'tool').map(e => e.itemId)).size, 2);
    assert.deepEqual(h.notices, ['missing-id']);
    h.state.close({ kind: 'turn-end', status: 'stopped', finalText: null });
    assert.ok(h.events.filter(e => e.kind === 'tool').slice(-2).every(e => e.status === 'stopped'));
});

test('legacy parser start/update are still empty and sidecar filters binary result blocks', () => {
    assert.deepEqual(parsePiRpcRecord({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash' }), {});
    assert.deepEqual(parsePiRpcRecord({ type: 'tool_execution_update', toolCallId: 'x', toolName: 'bash' }), {});
    const parsed = parsePiActivityRecord({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'read',
        result: { content: [{ type: 'image', data: 'secret-base64' }, { type: 'text', text: 'visible' }] } });
    assert.equal(parsed?.kind === 'tool' ? parsed.output : null, 'visible');
    assert.equal(parsePiActivityRecord({ type: 'response', command: 'prompt', success: true }), null);
    assert.equal(parsePiActivityRecord(null), null);
});

test('Pi producer redacts whole known args before preview clipping and real codec persistence', () => {
    const events: RuntimeEvent[] = [];
    const stored: unknown[] = [];
    const state = new RuntimeProjection({ runId: 'pi', sessionId: 'jaw', scope: 'scope', turnId: 'turn', audience: 'internal' },
        (context, body) => {
            assert.ok(!JSON.stringify(body).includes('Canary'), 'producer already sanitized before codec');
            const identity = { version: 1 as const, runId: context.runId, sessionId: context.sessionId,
                scope: context.scope, turnId: context.turnId, seq: (stored.length + 1) * 3 };
            const raw = JSON.parse(stringifyTraceValue(encodeRuntimeBody(identity, body).raw));
            stored.push(raw);
            const event = decodeRuntimeBody(raw, identity, body.kind);
            assert.ok(event);
            events.push(event);
            return event;
        }, () => {});
    const pi = new PiProjection(state);
    pi.observeRecord({ type: 'tool_execution_start', toolCallId: 'private-id', toolName: 'bash',
        args: '{"password":"partialCanary' });
    pi.observeRecord({ type: 'tool_execution_end', toolCallId: 'private-id', toolName: 'bash',
        args: { password: 'completeCanary', padding: 'x'.repeat(10_000) },
        result: { content: [{ type: 'image', data: 'imageCanary' }, { type: 'text', text: '[ -f file ]' }] } });
    const tools = events.filter(event => event.kind === 'tool');
    assert.equal(tools[0]?.input, '[structured content withheld]');
    assert.ok(tools.at(-1)?.input?.includes('[REDACTED]'));
    assert.ok((tools.at(-1)?.input?.length ?? 0) <= 3000);
    assert.equal(tools.at(-1)?.output, '[ -f file ]');
    assert.ok(!JSON.stringify(stored).includes('Canary'));
    assert.ok(!JSON.stringify(events).includes('private-id'));
});
