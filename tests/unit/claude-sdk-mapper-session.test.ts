import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';
mock.module('../../src/trace/activity-journal.js', { namedExports: { appendActivityBody: () => null, markActivityFailure: () => {} } });
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');

class Output implements AsyncIterableIterator<SDKMessage> {
    values: SDKMessage[] = [];
    waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
    ended = false;
    [Symbol.asyncIterator]() { return this; }
    next(): Promise<IteratorResult<SDKMessage>> {
        if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => { this.waiting = resolve; });
    }
    push(value: Record<string, unknown>) {
        const frame = value as unknown as SDKMessage; // Malformed frames intentionally exercise the ingress boundary.
        if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ done: false, value: frame }); }
        else this.values.push(frame);
    }
    close() { this.ended = true; this.waiting?.({ done: true, value: undefined }); this.waiting = undefined; }
}
async function fixture(t: TestContext, failure?: 'null' | 'throw') {
    const output = new Output(), events: RuntimeEvent[] = [], sent: SDKUserMessage[] = [], metadata: unknown[] = [];
    let current = true, turn = 0, seq = 0;
    const session = await createClaudeSdkSession({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', permissions: 'safe',
            systemPrompt: '', fastMode: false }, promptTimeoutMs: 1000, closeTimeoutMs: 100,
        getTurnContext: () => ({ runId: 'run-' + (++turn), sessionId: 'jaw', scope: 'different-scope',
            turnId: 'turn-' + turn, audience: 'internal', isCurrent: () => current }),
        record: (owner, body) => {
            if (failure === 'null') return null;
            if (failure === 'throw') throw new Error('journal-secret');
            const event: RuntimeEvent = { ...owner, version: 1, seq: seq += 3, ...body }; events.push(event); return event;
        },
        onMetadata: (_owner, data) => { metadata.push(data); },
        queryFactory: ({ prompt }) => {
            void (async () => { for await (const input of prompt) sent.push(input); })();
            return { [Symbol.asyncIterator]: () => output, close: () => output.close() };
        },
    });
    t.after(() => session.close());
    return { session, events, sent, metadata, output, revoke: () => { current = false; },
        stream: (event: object) => output.push({ type: 'stream_event', parent_tool_use_id: null, event }),
        partial: () => output.push({ type: 'assistant', message: { id: 'private-parent', content: [{ type: 'text', text: 'PARTIAL' }] } }),
        result: (extra: Record<string, unknown> = {}) => output.push({ type: 'result', subtype: 'success', is_error: false,
            session_id: 'private-native', uuid: 'result-' + turn, num_turns: 1, result: 'FINAL',
            total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 }, ...extra }),
    };
}

test('parent streaming, tool JSON/output, reasoning and final share captured canonical ownership', async t => {
    const f = await fixture(t), result = f.session.send({ text: 'one' }, () => {});
    f.stream({ type: 'message_start', message: { id: 'private-parent' } });
    f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A' } });
    f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'B' } });
    f.stream({ type: 'content_block_stop', index: 0 });
    f.output.push({ type: 'assistant', uuid: 'snapshot', message: { id: 'private-parent', content: [{ type: 'text', text: 'ABC' }] } });
    f.stream({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'PROVIDER_REASONING' } });
    f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'SIGNATURE_CANARY' } });
    f.stream({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'private-tool', name: 'Read', input: {} } });
    f.stream({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"fixture","token":"TOKEN_CANARY"}' } });
    f.stream({ type: 'content_block_stop', index: 2 });
    f.output.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'private-tool', content: 'TOOL_OUTPUT' }] } });
    f.result();
    assert.deepEqual(await result, { status: 'done', finalText: 'FINAL', partialText: 'ABC' });
    const tools = f.events.filter(event => event.kind === 'tool');
    assert.equal(new Set(tools.map(event => event.itemId)).size, 1);
    assert.equal(tools.at(-1)?.status, 'done'); assert.equal(tools.at(-1)?.output, 'TOOL_OUTPUT');
    assert.ok(tools.at(-1)?.input?.includes('[REDACTED]'));
    assert.equal(f.events.filter(event => event.kind === 'reasoning').at(-1)?.text, 'PROVIDER_REASONING');
    assert.equal(f.events.filter(event => event.kind === 'message' && event.phase === 'final').length, 1);
    assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 1);
    assert.ok(f.events.findIndex(event => event.kind === 'usage') < f.events.findIndex(event => event.kind === 'turn-end'));
    assert.ok(f.events.every(event => event.runId === 'run-1' && event.sessionId === 'jaw' && event.scope === 'different-scope'));
    assert.deepEqual(f.events.map(event => event.seq), f.events.map((_, index) => (index + 1) * 3));
    assert.ok(!JSON.stringify(f.events).match(/TOKEN_CANARY|SIGNATURE_CANARY|private-tool|private-parent/));
});

for (const action of ['stop', 'revoke'] as const) test(`usage observer ${action} precedes terminal choice and blocks success metadata`, async t => {
    const f = await fixture(t); let closing: Promise<void> | undefined;
    const result = f.session.send({ text: 'one' }, event => {
        if (event.kind === 'usage') { if (action === 'stop') closing = f.session.cancel(); else f.revoke(); }
    });
    f.partial(); f.result();
    assert.deepEqual(await result, { status: action === 'stop' ? 'stopped' : 'error', finalText: null, partialText: 'PARTIAL' });
    await closing; assert.equal(f.metadata.length, 0); assert.equal(f.session.nativeSessionId, '');
    assert.equal(f.events.some(event => event.kind === 'message' && event.phase === 'final'), false);
});

for (const stop of [false, true]) test(`terminal publication fences reentrant input; post-choice Stop=${stop}`, async t => {
    const f = await fixture(t); let rejected: Promise<void> | undefined, closing: Promise<void> | undefined;
    const idle: boolean[] = [];
    const result = f.session.send({ text: 'one' }, event => {
        if (event.kind === 'message' && event.phase === 'final') {
            idle.push(f.session.idle);
            rejected = assert.rejects(f.session.send({ text: 'too early' }, () => {}), /session_busy/);
            if (stop) closing = f.session.cancel();
        }
    });
    f.result(); assert.equal((await result).finalText, 'FINAL'); await rejected; await closing;
    assert.deepEqual(idle, [false]); assert.equal(f.sent.length, 1);
    assert.deepEqual(f.events.map(event => event.kind), ['turn-start', 'usage', 'message', 'turn-end']);
    if (!stop) {
        assert.equal(f.session.idle, true);
        const next = f.session.send({ text: 'after end' }, () => {}); f.result(); await next;
        assert.equal(f.events[3]?.kind, 'turn-end'); assert.equal(f.events[4]?.kind, 'turn-start');
        assert.equal(f.sent.length, 2);
    } else assert.equal(f.session.alive, false);
});

for (const failure of ['null', 'throw'] as const) test(`recorder ${failure} cannot suppress mapper final or independent partial`, async t => {
    const f = await fixture(t, failure), result = f.session.send({ text: 'one' }, () => {});
    f.partial(); f.result();
    assert.deepEqual(await result, { status: 'done', finalText: 'FINAL', partialText: 'PARTIAL' });
    assert.equal(f.events.length, 0); assert.equal(f.metadata.length, 1);
});

for (const value of [null, '', undefined]) test(`mapper result ${String(value)} never promotes the parent partial`, async t => {
    const f = await fixture(t), result = f.session.send({ text: 'one' }, () => {});
    f.partial(); f.result({ result: value });
    assert.deepEqual(await result, { status: 'done', finalText: value ?? null, partialText: 'PARTIAL' });
    assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 1);
    assert.equal(f.events.filter(event => event.kind === 'message' && event.phase === 'final').length, value === '' ? 1 : 0);
});

test('malformed parent snapshot cannot update private identity or accepted metadata', async t => {
    const f = await fixture(t), result = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'MALFORMED' }] } });
    f.result();
    assert.deepEqual(await result, { status: 'error', finalText: null, partialText: '' });
    assert.equal(f.metadata.length, 0); assert.equal(f.session.nativeSessionId, '');
});

test('child streaming, result and tool output cannot leak into the parent mapper', async t => {
    const f = await fixture(t), result = f.session.send({ text: 'one' }, () => {}); f.partial();
    for (const frame of [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'child' } } },
        { type: 'assistant', message: { id: 'child', content: [{ type: 'text', text: 'CHILD_CANARY' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'child', content: 'CHILD_CANARY' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'CHILD_CANARY', session_id: 'child-native' },
    ]) f.output.push({ ...frame, parent_tool_use_id: 'private-child' });
    f.result();
    assert.deepEqual(await result, { status: 'done', finalText: 'FINAL', partialText: 'PARTIAL' });
    assert.ok(!JSON.stringify(f.events).includes('CHILD_CANARY')); assert.equal(f.session.nativeSessionId, 'private-native');
});
