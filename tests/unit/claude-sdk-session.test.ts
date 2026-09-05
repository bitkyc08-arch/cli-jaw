import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// Recorders are injected here; module loading must not initialize shared SQLite.
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => null } });
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');
import { createClaudeProcessOwner } from '../../src/agent/runtime/claude-sdk-process.ts';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';

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
    const registry = new RuntimeRequests(); let callback;
    let queryCount = 0, contextReads = 0, closed = 0, seq = 0;
    const session = await createClaudeSdkSession({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: 'instructions', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 1000, closeTimeoutMs: 5000,
        registry,
        getTurnContext: () => { contextReads++; return context; },
        onMetadata: (owner, data) => metadata.push({ owner, data }),
        record: (owner, body) => { const event = { version: 1, ...owner, ...body, seq: seq += 3 }; events.push(event); return event; },
        queryFactory: ({ prompt, options }) => { queryCount++; callback = options.canUseTool; void (async () => { for await (const message of prompt) sent.push(message); })(); return { ...output, close() { closed++; output.close(); } }; },
        ...extra,
    });
    return { session, output, sent, events, metadata, registry, get callback() { return callback; },
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
test('journal failure and observer throws cannot suppress direct final outcome', async t => {
    const f = await fixture({ record: () => { throw new Error('disk full'); } }); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => { throw new Error('observer'); });
    f.output.push(result('direct')); assert.equal((await turn).finalText, 'direct');
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
    const child = owner.spawn({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(23),8000)'],
        env: process.env, signal: new AbortController().signal });
    child.stdout.resume(); owner.terminate(); await owner.wait();
    assert.equal(owner.activeCount, 0); assert.notEqual(child.exitCode, 23); assert.ok(child.exitCode !== null || child.signalCode !== null);
});
test('query factory error after child spawn retires only its created child', async () => {
    let child;
    await assert.rejects(fixture({ queryFactory: ({ options }) => {
        child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(23),8000)'],
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
test('wrong first-frame correlation fences all unmarked foreign frames before metadata', async () => {
    const f = await fixture();
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'stream_event', user_message_uuid: 'foreign', event: { type: 'message_start', message: { id: 'foreign-message' } } });
    f.output.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'foreign text' } } });
    f.output.push({ ...result('foreign'), session_id: 'foreign-session' });
    assert.deepEqual(await turn, { status: 'error', finalText: null, partialText: '' });
    assert.equal(f.metadata.length, 0); assert.equal(f.session.nativeSessionId, '');
    assert.ok(!JSON.stringify(f.events).includes('foreign text'));
    await f.session.close();
});
test('duplicate previous result UUID cannot finish the next admitted send', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const one = f.session.send({ text: 'one' }, () => {});
    f.output.push({ ...result('first'), uuid: 'result1' }); await one;
    const two = f.session.send({ text: 'two' }, () => {});
    f.output.push({ ...result('first'), uuid: 'result1' });
    f.output.push({ ...result('second'), uuid: 'result2' });
    assert.equal((await two).finalText, 'second');
});
test('streaming delta is available for salvage before any completed assistant snapshot', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
    f.output.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    f.output.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'salvage' } } });
    f.output.close();
    assert.deepEqual(await turn, { status: 'error', finalText: null, partialText: 'salvage' });
});
test('idle result UUID is fenced before next send and cannot replay into its outcome', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    f.output.push({ ...result('idle'), uuid: 'idle-result' });
    await new Promise(resolve => setImmediate(resolve));
    const turn = f.session.send({ text: 'current' }, () => {});
    f.output.push({ ...result('idle'), uuid: 'idle-result', session_id: 'stale-session' });
    f.output.push({ ...result('actual'), uuid: 'actual-result' });
    assert.equal((await turn).finalText, 'actual'); assert.equal(f.metadata.length, 1);
});
test('usage observer revocation cannot return a successful stale final', async () => {
    let current = true;
    const f = await fixture({ getTurnContext: () => ({ runId: 'r', sessionId: 'j', scope: 's', turnId: 't', audience: 'internal', isCurrent: () => current }) });
    const turn = f.session.send({ text: 'one' }, event => { if (event.kind === 'usage') current = false; });
    f.output.push(result('stale answer'));
    assert.deepEqual(await turn, { status: 'error', finalText: null, partialText: '' });
    await f.session.close(); assert.equal(f.session.alive, false);
});
test('SDK permission callback is answered through exact existing request registry binding', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'printf hello' } }] } });
    await new Promise(resolve => setImmediate(resolve));
    const answer = f.callback('Bash', { command: 'printf hello' }, { signal: new AbortController().signal, toolUseID: 'tool1', requestId: 'sdk1', title: 'Run printf hello' });
    await new Promise(resolve => setImmediate(resolve));
    const pending = f.registry.list('jaw')[0]!; assert.ok(pending);
    f.registry.respond(pending.requestId, pending, { optionId: 'allow' });
    assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { command: 'printf hello' } });
    f.output.push(result()); await turn; assert.equal(f.registry.list('jaw').length, 0);
});
test('Stop settles a pending SDK callback and preserves separate stopped outcome', async () => {
    const f = await fixture(); const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'printf hello' } }] } });
    await new Promise(resolve => setImmediate(resolve));
    const answer = f.callback('Bash', { command: 'printf hello' }, { signal: new AbortController().signal, toolUseID: 'tool1', requestId: 'sdk1', title: 'Run printf hello' });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.registry.list('jaw').length, 1);
    await f.session.cancel(); assert.equal((await answer).behavior, 'deny'); assert.equal((await turn).status, 'stopped');
    assert.equal(f.registry.list('jaw').length, 0);
});
test('retired SDK callback cannot attach to the next borrower', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const one = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'old-tool', name: 'Bash', input: {} }] } });
    f.output.push(result()); await one;
    const two = f.session.send({ text: 'two' }, () => {});
    const answer = await f.callback('Bash', { command: 'printf hello' }, { signal: new AbortController().signal, toolUseID: 'old-tool', requestId: 'old-sdk', title: 'Old tool' });
    assert.equal(answer.behavior, 'deny'); assert.equal(f.registry.list('jaw').length, 0);
    f.output.push(result('second')); assert.equal((await two).finalText, 'second');
});
test('safe init reporting bypass refuses the turn instead of treating it as safe', async () => {
    const f = await fixture(); const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'system', subtype: 'init', permissionMode: 'bypassPermissions', session_id: 'unsafe' });
    assert.equal((await turn).status, 'error'); assert.equal(f.session.nativeSessionId, ''); await f.session.close();
});
test('zero-turn resume handshake cannot complete newly offered user input', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'actual user' }, () => {});
    f.output.push({ ...result('resume handshake'), num_turns: 0, uuid: 'handshake' });
    f.output.push({ ...result('actual answer'), num_turns: 1, uuid: 'user-result' });
    assert.equal((await turn).finalText, 'actual answer'); assert.equal(f.metadata.length, 1);
});
test('deferred lifecycle finalizer owns final text and blocks the next send until exact finalize', async t => {
    const f = await fixture({ deferTurnEnd: true }); t.after(() => f.session.close());
    const first = f.session.send({ text: 'one' }, () => {}); f.output.push(result('provider candidate'));
    assert.equal((await first).finalText, 'provider candidate'); assert.equal(f.session.idle, false);
    assert.equal(f.events.filter(e => e.kind === 'turn-end' || e.phase === 'final').length, 0);
    await assert.rejects(f.session.send({ text: 'too early' }, () => {}), /busy/);
    assert.equal(f.session.finalizeTurn('wrong', { kind: 'turn-end', status: 'done', finalText: 'wrong' }), false);
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'unclaimed' }), false);
    assert.equal(f.session.claimTurnOutcome('wrong'), null);
    const claimed = f.session.claimTurnOutcome('turn1');
    assert.equal(claimed?.finalText, 'provider candidate'); assert.ok(Object.isFrozen(claimed));
    assert.equal(f.session.claimTurnOutcome('turn1'), claimed);
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'policy-selected' }), true);
    assert.equal(f.events.filter(e => e.kind === 'turn-end').at(-1).finalText, 'policy-selected');
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'duplicate' }), false);
    assert.equal(f.session.idle, true);
    await assert.rejects(f.session.send({ text: 'reused id' }, () => {}), /identity_reused/);
    f.context({ runId: 'run2', sessionId: 'jaw', scope: 'scope', turnId: 'turn2', audience: 'internal', isCurrent: () => true });
    const second = f.session.send({ text: 'two' }, () => {}); f.output.push(result('second')); await second;
    assert.equal(f.session.claimTurnOutcome('turn1'), null);
    assert.equal(f.session.claimTurnOutcome('turn2')?.finalText, 'second');
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'old duplicate' }), false);
    assert.equal(f.session.finalizeTurn('turn2', { kind: 'turn-end', status: 'done', finalText: '' }), true);
    assert.equal(f.events.filter(e => e.kind === 'turn-end').at(-1).finalText, '');
});
test('deferred physical Stop waits for child cleanup without fabricating a canonical end', async () => {
    const f = await fixture({ deferTurnEnd: true });
    const turn = f.session.send({ text: 'one' }, () => {}); await f.session.cancel();
    assert.equal((await turn).status, 'stopped'); assert.equal(f.events.filter(e => e.kind === 'turn-end').length, 0);
    assert.equal(f.session.claimTurnOutcome('turn1')?.status, 'stopped');
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'stopped', finalText: null }), true);
    assert.equal(f.events.filter(e => e.kind === 'turn-end').at(-1).status, 'stopped');
});
test('passive stopped finalizer survives main-run deletion and emits only its captured old identity once', async () => {
    let current = true;
    const f = await fixture({ deferTurnEnd: true, getTurnContext: () => ({ runId: 'old-run', sessionId: 'old-chat', scope: 'old-scope', turnId: 'old-turn', audience: 'internal', isCurrent: () => current }) });
    const turn = f.session.send({ text: 'one' }, () => {});
    current = false; await f.session.cancel(); assert.equal((await turn).status, 'stopped');
    assert.equal(f.session.claimTurnOutcome('old-turn')?.status, 'stopped');
    assert.equal(f.session.finalizeTurn('new-turn', { kind: 'turn-end', status: 'done', finalText: 'wrong' }), false);
    assert.equal(f.session.finalizeTurn('old-turn', { kind: 'turn-end', status: 'stopped', finalText: null }), true);
    assert.equal(f.session.finalizeTurn('old-turn', { kind: 'turn-end', status: 'stopped', finalText: null }), false);
    const ends = f.events.filter(e => e.kind === 'turn-end'); assert.equal(ends.length, 1);
    assert.equal(ends[0].sessionId, 'old-chat'); assert.equal(ends[0].runId, 'old-run');
});
test('unexpected SDK background start retires query instead of returning an application final', async () => {
    const f = await fixture(); const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'system', subtype: 'task_started', task_id: 'background', tool_use_id: 'agent', is_backgrounded: true });
    const result = await turn; assert.equal(result.status, 'error'); assert.equal(result.finalText, null);
    assert.equal(f.session.lastError, 'claude_background_tasks_unsupported'); await f.session.close();
    assert.equal(f.closed, 1); assert.ok(!f.events.some(event => event.parentItemId && event.status === 'stopped'));
});
test('late background violation invalidates deferred candidate before successful finalization', async () => {
    const f = await fixture({ deferTurnEnd: true });
    const turn = f.session.send({ text: 'one' }, () => {}); f.output.push(result('candidate')); await turn;
    f.output.push({ type: 'system', subtype: 'task_started', task_id: 'late', is_backgrounded: true });
    await new Promise(resolve => setImmediate(resolve)); await f.session.close();
    assert.equal(f.session.getTurnOutcome('turn1')?.status, 'error');
    assert.equal(f.session.claimTurnOutcome('turn1')?.status, 'error');
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'candidate' }), false);
    assert.equal(f.events.filter(e => e.kind === 'turn-end').length, 0);
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'error', finalText: null }), true);
    assert.equal(f.events.filter(e => e.kind === 'turn-end').at(-1).finalText, null);
});
test('context outside the shared event and response ID bounds is rejected before input', async t => {
    const f = await fixture({ getTurnContext: () => ({ runId: 'r', sessionId: 's', scope: 'x'.repeat(241), turnId: 't', audience: 'internal', isCurrent: () => true }) });
    t.after(() => f.session.close());
    await assert.rejects(f.session.send({ text: 'must not run' }, () => {}), /invalid_context/);
    assert.equal(f.sent.length, 0);
});
test('Stop after physical candidate updates the pending logical outcome without changing completed standalone semantics', async () => {
    const f = await fixture({ deferTurnEnd: true });
    const turn = f.session.send({ text: 'one' }, () => {}); f.output.push(result('candidate')); await turn;
    await f.session.cancel();
    assert.equal(f.session.getTurnOutcome('turn1')?.status, 'stopped');
    assert.equal(f.session.claimTurnOutcome('turn1')?.status, 'stopped');
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'candidate' }), false);
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'stopped', finalText: null }), true);
});
test('idle result capacity retires neutrally without turning a deferred done candidate into Stop', async () => {
    const f = await fixture({ deferTurnEnd: true });
    const turn = f.session.send({ text: 'one' }, () => {}); f.output.push({ ...result('candidate'), uuid: 'first' }); await turn;
    for (let i = 0; i < 511; i++) f.output.push({ ...result('idle'), uuid: `idle-${i}` });
    await new Promise(resolve => setImmediate(resolve)); await f.session.close();
    assert.equal(f.session.getTurnOutcome('turn1')?.status, 'done');
    assert.equal(f.session.claimTurnOutcome('turn1')?.status, 'done');
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'candidate' }), true);
    assert.equal(f.events.filter(e => e.kind === 'turn-end').at(-1).finalText, 'candidate');
});
test('claimed done is immutable across later protocol failure while the query retires', async () => {
    const f = await fixture({ deferTurnEnd: true });
    const turn = f.session.send({ text: 'one' }, () => {}); f.output.push(result('candidate')); await turn;
    const claimed = f.session.claimTurnOutcome('turn1'); assert.equal(claimed?.status, 'done');
    f.output.push({ type: 'system', subtype: 'task_started', task_id: 'late', is_backgrounded: true });
    await new Promise(resolve => setImmediate(resolve)); await f.session.close();
    assert.equal(f.session.alive, false); assert.equal(f.session.claimTurnOutcome('turn1'), claimed);
    assert.equal(f.session.getTurnOutcome('turn1')?.status, 'done');
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'candidate' }), true);
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'done', finalText: 'twice' }), false);
    const ends = f.events.filter(e => e.kind === 'turn-end'); assert.equal(ends.length, 1); assert.equal(ends[0].status, 'done');
});
test('explicit Stop after claim retires the query without retroactively mutating the claim', async () => {
    const f = await fixture({ deferTurnEnd: true });
    const turn = f.session.send({ text: 'one' }, () => {}); f.output.push(result('candidate')); await turn;
    const claimed = f.session.claimTurnOutcome('turn1'); await f.session.cancel();
    assert.equal(f.session.claimTurnOutcome('turn1'), claimed); assert.equal(claimed?.status, 'done');
    assert.equal(f.session.finalizeTurn('turn1', { kind: 'turn-end', status: 'stopped', finalText: null }), true);
});
test('session exposes the actual SDK-created root and readiness waits without spawning another', async () => {
    const output = stream(); let child;
    const f = await fixture({ queryFactory: ({ options }) => {
        child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(23),8000)'],
            env: process.env, signal: new AbortController().signal });
        return { ...output, close() { output.close(); } };
    } });
    try {
        assert.equal(await f.session.waitForPrimaryChild({ timeoutMs: 1000 }), child);
        assert.equal(f.session.primaryChild, child); assert.equal(f.session.rootProcessState.kind, 'single');
        assert.equal(f.session.activeProcessCount, 1); assert.ok(child.pid > 0);
    } finally { await f.session.close(); }
    assert.equal(f.session.activeProcessCount, 0);
});
test('multiple SDK root creation fails acquisition and disposes every captured real child', async () => {
    const children = [], output = stream();
    await assert.rejects(fixture({ queryFactory: ({ options }) => {
        for (let i = 0; i < 2; i++) children.push(options.spawnClaudeCodeProcess({ command: process.execPath,
            args: ['-e', 'setTimeout(()=>process.exit(23),8000)'], env: process.env, signal: new AbortController().signal }));
        return { ...output, close() { output.close(); } };
    } }), /multiple_root_processes/);
    assert.equal(children.length, 2);
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});
