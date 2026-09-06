import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeSdkSession } from '../../src/agent/runtime/claude-sdk-session.ts';
import { createClaudeProcessOwner } from '../../src/agent/runtime/claude-sdk-process.ts';

function stream() {
    const values: unknown[] = [];
    let waiting: ((x: IteratorResult<unknown>) => void) | undefined;
    let ended = false;
    return {
        push(value: unknown) { if (waiting) { const resolve = waiting; waiting = undefined; resolve({ done: false, value }); } else values.push(value); },
        close() { ended = true; waiting?.({ done: true, value: undefined }); waiting = undefined; },
        [Symbol.asyncIterator]() { return this; },
        next(): Promise<IteratorResult<unknown>> {
            if (values.length) return Promise.resolve({ done: false, value: values.shift() });
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise(resolve => { waiting = resolve; });
        },
    };
}
async function fixture(extra: Record<string, unknown> = {}) {
    const output = stream();
    let context = { runId: 'run1', sessionId: 'jaw', scope: 'scope', turnId: 'turn1', audience: 'internal', isCurrent: () => true };
    const sent: unknown[] = [], events: unknown[] = [], metadata: unknown[] = [];
    let queryCount = 0, contextReads = 0, closed = 0, seq = 0;
    const session = await createClaudeSdkSession({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: 'instructions', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 1000, closeTimeoutMs: 100,
        getTurnContext: () => { contextReads++; return context; },
        onMetadata: (owner, data) => metadata.push({ owner, data }),
        record: (owner, body) => { const event = { version: 1, ...owner, ...body, seq: seq += 3 }; events.push(event); return event; },
        queryFactory: ({ prompt }) => { queryCount++; void (async () => { for await (const message of prompt) sent.push(message); })(); return { ...output, close() { closed++; output.close(); } }; },
        ...extra,
    });
    return { session, output, sent, events, metadata,
        get queryCount() { return queryCount; }, get contextReads() { return contextReads; }, get closed() { return closed; },
        context(value: typeof context) { context = value; } };
}
const result = (text: unknown = 'answer') => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'native', usage: { input_tokens: 3, output_tokens: 4 } });

test('one reader and query serve sequential turns with captured jaw identity', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const first = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' });
    f.context({ runId: 'run2', sessionId: 'jaw2', scope: 'scope2', turnId: 'turn2', audience: 'internal', isCurrent: () => true });
    f.output.push(result('one answer'));
    assert.equal((await first).finalText, 'one answer');
    assert.equal(f.session.nativeSessionId, 'native');
    assert.equal(f.contextReads, 1);
    assert.ok(f.events.every(e => e.runId === 'run1' && e.sessionId === 'jaw'));
    const second = f.session.send({ text: 'two' }, () => {});
    f.output.push(result('two answer'));
    assert.equal((await second).finalText, 'two answer');
    assert.equal(f.queryCount, 1); assert.equal(f.contextReads, 2); assert.equal(f.sent.length, 2);
    assert.equal(f.closed, 0); assert.equal(f.session.idle, true);
    assert.deepEqual(f.metadata[1].data.tokens, { input: 3, output: 4 });
});
test('concurrent input rejects without extra offer; unsupported steer never offers', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    await assert.rejects(f.session.send({ text: 'two' }, () => {}), /busy/);
    assert.equal((await f.session.steer({ text: 'three' })).accepted, false);
    f.output.push(result()); await turn; assert.equal(f.sent.length, 1);
});
test('authoritative empty and absent final never promote parent partial', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    for (const final of ['', undefined]) {
        const turn = f.session.send({ text: 'one' }, () => {});
        f.output.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'partial' }] } });
        f.output.push({ ...result(), result: final });
        assert.deepEqual(await turn, { status: 'done', finalText: final ?? null, partialText: 'partial' });
    }
});
test('EOF produces error with parent salvage, excluding child output', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'p', content: [{ type: 'text', text: 'parent' }] } });
    f.output.push({ type: 'assistant', parent_tool_use_id: 'child', message: { id: 'c', content: [{ type: 'text', text: 'child' }] } });
    f.output.close();
    assert.deepEqual(await turn, { status: 'error', finalText: null, partialText: 'parent' });
    assert.equal(f.session.alive, false);
});
test('journal failure cannot suppress direct final outcome', async t => {
    const f = await fixture({ record: () => { throw new Error('disk full'); } }); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => { throw new Error('observer'); });
    f.output.push(result('direct')); assert.equal((await turn).finalText, 'direct');
});
test('observer throws after successful recording cannot suppress outcome or close', async () => {
    const f = await fixture();
    let observed = 0;
    try {
        const turn = f.session.send({ text: 'one' }, () => { observed++; throw new Error('observer'); });
        f.output.push(result('direct'));
        assert.equal((await turn).finalText, 'direct');
        assert.equal(observed, 2);
        assert.equal(f.events.length, 2);
    } finally { await f.session.close(); }
    assert.equal(f.closed, 1);
    assert.equal(f.session.alive, false);
});
test('timeout retires query and settlement does not wait forever', async t => {
    const f = await fixture({ promptTimeoutMs: 10 }); t.after(() => f.session.close());
    assert.equal((await f.session.send({ text: 'one' }, () => {})).status, 'error');
    assert.equal(f.session.alive, false);
});
test('Stop fences synchronous stale result and resolves stopped once', async () => {
    const f = await fixture();
    const turn = f.session.send({ text: 'one' }, () => {});
    const close = f.session.cancel(); f.output.push(result('stale'));
    assert.equal((await turn).status, 'stopped'); await close;
    await f.session.close(); assert.equal(f.closed, 1);
    await assert.rejects(f.session.send({ text: 'later' }, () => {}), /closed/);
});
test('custom child drains stderr beyond pipe capacity and observes actual exit', async t => {
    const owner = createClaudeProcessOwner();
    t.after(async () => { owner.terminate(); await owner.wait(); });
    const child = owner.spawn({ command: process.execPath,
        args: ['-e', "process.stderr.write('x'.repeat(1024*1024),()=>process.exit(0))"],
        env: process.env, signal: new AbortController().signal });
    child.stdout.resume(); await owner.wait();
    assert.equal(child.exitCode, 0); assert.equal(owner.activeCount, 0); assert.equal(owner.stderrBytes, 1024 * 1024);
});
test('custom child termination waits for exit, not killed flag', async () => {
    const owner = createClaudeProcessOwner();
    const child = owner.spawn({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(23),2000)'],
        env: process.env, signal: new AbortController().signal });
    child.stdout.resume(); owner.terminate(); await owner.wait();
    assert.equal(owner.activeCount, 0); assert.notEqual(child.exitCode, 23); assert.ok(child.exitCode !== null || child.signalCode !== null);
});
test('query factory error after child spawn retires only its created child', async () => {
    let child;
    await assert.rejects(fixture({ queryFactory: ({ options }) => {
        child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(23),2000)'],
            env: process.env, signal: new AbortController().signal });
        throw new Error('factory failure');
    } }), /factory failure/);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.notEqual(child.exitCode, 23);
});
test('turn-start observer can revoke ownership before input offer', async () => {
    let current = true;
    const f = await fixture({ getTurnContext: () => ({ runId: 'r', sessionId: 'j', scope: 's', turnId: 't', audience: 'internal', isCurrent: () => current }) });
    const result = await f.session.send({ text: 'never send' }, () => { current = false; });
    assert.equal(result.status, 'stopped'); assert.equal(f.sent.length, 0);
    await f.session.close();
});
