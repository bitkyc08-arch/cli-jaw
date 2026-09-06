import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';
import { FULLTEXT_MAX_CHARS } from '../../src/agent/events/fulltext-bound.ts';
import { lifecycleRuntimeOutcome } from '../../src/agent/runtime/outcome.ts';
import type { RuntimeEnd } from '../../src/agent/runtime/projection.ts';
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => null } });
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');

async function fixture(t: TestContext, recording: 'ok' | 'null' | 'throw' = 'ok') {
    const frames: SDKMessage[] = [], events: RuntimeEvent[] = [];
    let pending: ((value: IteratorResult<SDKMessage>) => void) | undefined;
    let closed = false, current = true, turnId = 'turn-1', seq = 0, sent = 0;
    const push = (value: Record<string, unknown>) => {
        const frame = value as unknown as SDKMessage;
        if (pending) { const resolve = pending; pending = undefined; resolve({ done: false, value: frame }); }
        else frames.push(frame);
    };
    const session = await createClaudeSdkSession({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '', permissions: 'safe', fastMode: false },
        deferTurnEnd: true, promptTimeoutMs: 1000, closeTimeoutMs: 100,
        getTurnContext: () => ({ runId: turnId, turnId, sessionId: 'chat', scope: 'scope', audience: 'internal', isCurrent: () => current }),
        record: (owner, body) => {
            if (recording === 'null') return null;
            if (recording === 'throw') throw new Error('fixture persistence unavailable');
            const event: RuntimeEvent = { ...owner, version: 1, seq: ++seq, ...body }; events.push(event); return event;
        },
        queryFactory: ({ prompt }) => {
            void (async () => { for await (const _message of prompt) sent++; })();
            return {
                [Symbol.asyncIterator]() { return this; },
                next(): Promise<IteratorResult<SDKMessage>> {
                    if (frames.length) return Promise.resolve({ done: false, value: frames.shift()! });
                    if (closed) return Promise.resolve({ done: true, value: undefined });
                    return new Promise(resolve => { pending = resolve; });
                },
                close() { closed = true; pending?.({ done: true, value: undefined }); pending = undefined; },
            };
        },
    });
    t.after(() => session.close());
    return { session, events, push, revoke: () => { current = false; }, nextTurn: (id: string) => { turnId = id; },
        get sent() { return sent; },
        candidate: async (extra: Record<string, unknown> = {}) => {
            const result = session.send({ text: 'one' }, () => {});
            push({ type: 'assistant', message: { id: 'parent', content: [{ type: 'text', text: 'PARTIAL' }] } });
            push({ type: 'result', subtype: 'success', is_error: false, result: 'FINAL', session_id: 'native', num_turns: 1, ...extra });
            return result;
        },
    };
}
const end = (status: 'done' | 'error' | 'stopped', finalText: string | null) => ({ kind: 'turn-end' as const, status, finalText });
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));

test('candidate blocks input and emits no final until one exact claim/finalize', async t => {
    const f = await fixture(t), candidate = await f.candidate();
    assert.deepEqual(candidate, { status: 'done', finalText: 'FINAL', partialText: 'PARTIAL' });
    assert.equal(f.session.idle, false);
    await assert.rejects(f.session.send({ text: 'too early' }, () => {}), /busy/);
    assert.equal(f.session.claimTurnOutcome('foreign'), null);
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), false);
    assert.equal(f.events.some(event => event.kind === 'turn-end' || event.kind === 'message' && event.phase === 'final'), false);
    const copy = f.session.getTurnOutcome('turn-1')!; copy.finalText = 'mutated';
    const claim = f.session.claimTurnOutcome('turn-1');
    assert.ok(Object.isFrozen(claim)); assert.equal(claim?.finalText, 'FINAL');
    assert.equal(f.session.claimTurnOutcome('turn-1'), claim);
    assert.equal(f.session.finalizeTurn('foreign', end('done', 'FINAL')), false);
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), true);
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'again')), false);
    assert.equal(f.session.idle, true); assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 1);
});

test('Stop before claim changes only pending candidate and cannot upgrade stopped to done', async t => {
    const f = await fixture(t); await f.candidate(); await f.session.cancel();
    assert.deepEqual(f.session.claimTurnOutcome('turn-1'), { status: 'stopped', finalText: null, partialText: 'PARTIAL' });
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), false);
    assert.equal(f.session.finalizeTurn('turn-1', end('stopped', null)), true);
    assert.equal(f.events.some(event => event.kind === 'message' && event.phase === 'final'), false);
});

for (const late of ['stop', 'protocol failure'] as const) test(`immutable claim survives later ${late} and query retirement`, async t => {
    const f = await fixture(t); await f.candidate(); const claim = f.session.claimTurnOutcome('turn-1');
    if (late === 'stop') await f.session.cancel();
    else { f.push({ type: 'system', subtype: 'task_started', is_backgrounded: true }); await checkpoint(); await f.session.close(); }
    assert.equal(f.session.claimTurnOutcome('turn-1'), claim); assert.equal(claim?.status, 'done');
    assert.equal(f.session.alive, false);
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), true);
    assert.equal(f.events.filter(event => event.kind === 'turn-end').at(-1)?.status, 'done');
});

test('late protocol failure before claim changes pending result to error and survives explicit Stop', async t => {
    const f = await fixture(t); await f.candidate();
    f.push({ type: 'system', subtype: 'task_started', is_backgrounded: true }); await checkpoint(); await f.session.cancel();
    assert.equal(f.session.claimTurnOutcome('turn-1')?.status, 'error');
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), false);
    assert.equal(f.session.finalizeTurn('turn-1', end('error', null)), true);
});

test('neutral terminal-UUID capacity retirement preserves an unclaimed done candidate', async t => {
    const f = await fixture(t); await f.candidate({ uuid: 'first' });
    for (let i = 0; i < 511; i++) f.push({ type: 'result', subtype: 'success', is_error: false, result: 'idle', uuid: 'idle-' + i });
    await checkpoint(); await f.session.close();
    assert.equal(f.session.claimTurnOutcome('turn-1')?.status, 'done');
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), true);
});

test('passive finalization closes captured identity after active ownership revocation', async t => {
    const f = await fixture(t); await f.candidate(); f.session.claimTurnOutcome('turn-1'); f.revoke();
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), true);
    assert.ok(f.events.every(event => event.runId === 'turn-1' && event.sessionId === 'chat' && event.scope === 'scope'));
    assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 1);
    f.nextTurn('turn-2'); await assert.rejects(f.session.send({ text: 'forbidden active work' }, () => {}), /owner_stale/);
});

for (const recording of ['null', 'throw'] as const) test(`recorder ${recording} preserves claim and one-way finalization`, async t => {
    const f = await fixture(t, recording); await f.candidate();
    assert.equal(f.session.claimTurnOutcome('turn-1')?.finalText, 'FINAL');
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), true);
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), false);
    assert.equal(f.events.length, 0);
});

test('duplicate deferred identity is rejected before a second input offer', async t => {
    const f = await fixture(t); await f.candidate(); f.session.claimTurnOutcome('turn-1');
    f.session.finalizeTurn('turn-1', end('done', 'FINAL'));
    await assert.rejects(f.session.send({ text: 'duplicate' }, () => {}), /identity_reused/);
    assert.equal(f.sent, 1);
});

test('512 distinct deferred turns retire neutrally only after final publication', async t => {
    const f = await fixture(t);
    for (let i = 0; i < 512; i++) {
        const id = 'turn-' + i; f.nextTurn(id); await f.candidate();
        assert.equal(f.session.claimTurnOutcome(id)?.status, 'done');
        assert.equal(f.session.finalizeTurn(id, end('done', 'FINAL')), true);
    }
    assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 512);
    assert.equal(f.sent, 512); assert.equal(f.session.alive, false);
    f.nextTurn('turn-overflow'); await assert.rejects(f.session.send({ text: 'overflow' }, () => {}), /closed/);
});

test('invalid terminal kind/status/error or oversized final cannot consume the claim', async t => {
    const f = await fixture(t); await f.candidate(); f.session.claimTurnOutcome('turn-1');
    for (const invalid of [null, { ...end('done', null), kind: 'message' },
        { ...end('done', null), status: 'running' }, { ...end('done', null), status: 'unknown' },
        { ...end('done', null), error: 42 }]) {
        assert.equal(f.session.finalizeTurn('turn-1', invalid as unknown as RuntimeEnd), false);
        assert.equal(f.session.claimTurnOutcome('turn-1')?.status, 'done');
    }
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'x'.repeat(FULLTEXT_MAX_CHARS + 1))), false);
    assert.equal(f.session.finalizeTurn('turn-1', end('done', 'FINAL')), true);
});

for (const finalText of ['', 'COMMITTED']) test(`post-claim Stop retains authoritative ${JSON.stringify(finalText)} through existing lifecycle`, async t => {
    const f = await fixture(t); await f.candidate({ result: finalText });
    const claimed = f.session.claimTurnOutcome('turn-1')!;
    await f.session.cancel();
    const terminal = lifecycleRuntimeOutcome({ runtimeOutcome: claimed }, true)!;
    assert.equal(terminal.status, 'stopped'); assert.equal(terminal.finalText, finalText);
    assert.equal(f.session.finalizeTurn('turn-1', end(terminal.status, terminal.finalText)), true);
    const ends = f.events.filter(event => event.kind === 'turn-end');
    assert.equal(ends.length, 1); assert.equal(ends[0]?.status, 'stopped'); assert.equal(ends[0]?.finalText, finalText);
    assert.equal(f.session.claimTurnOutcome('turn-1'), null);
});
