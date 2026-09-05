import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';
import { AcpSession } from '../../src/agent/runtime/acp/session.ts';
import { AcpReplacement } from '../../src/agent/runtime/acp/replacement.ts';
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => null } });
const { AcpRuntimeSession } = await import('../../src/agent/runtime/acp/runtime-session.ts');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Wire = { id?: string; method?: string; params?: Record<string, any> };

async function fixture(t: TestContext, patch: Partial<ConstructorParameters<typeof AcpRuntimeSession>[1]> = {}) {
    const wire: Wire[] = [], events: RuntimeEvent[] = [], order: string[] = [];
    const child = Object.assign(new EventEmitter(), { pid: 62001, exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, stdin: new Writable(), stdout: new PassThrough(), stderr: new PassThrough() });
    let promptId: string | undefined, prompts = 0, current = true, record = true, failCancel = false;
    let responseBeforeWrite = false, writesHeld = false, heldWrite: (() => void) | undefined;
    let holdCancel = false, cancelReply: (() => void) | undefined, lateText = '';
    const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
    const update = (text: string) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    const finish = () => { update('B_FINAL'); reply(promptId, { stopReason: 'end_turn', _meta: { usage: { outputTokens: 3 } } }); };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk)) as Wire; wire.push(frame);
        if (frame.method === 'initialize') reply(frame.id, { protocolVersion: 1, agentCapabilities: {} });
        if (frame.method === 'session/new') reply(frame.id, { sessionId: 'native' });
        if (frame.method === 'session/prompt') {
            promptId = frame.id; prompts++;
            if (prompts === 1) update('A_PARTIAL');
            else if (responseBeforeWrite) finish();
            else setImmediate(finish);
            if (writesHeld) { heldWrite = done; return; }
        }
        if (frame.method === 'session/cancel') {
            order.push('cancel');
            if (lateText) update(lateText);
            if (failCancel) send({ jsonrpc: '2.0', id: promptId, error: { code: -32000, message: 'failure' } });
            else if (holdCancel) { const id = promptId; cancelReply = () => reply(id, { stopReason: 'cancelled' }); }
            else reply(promptId, { stopReason: 'cancelled' });
        }
        done();
    } });
    const exit = () => { if (child.exitCode !== null) return; child.exitCode = 143; child.emit('exit', 143); child.emit('close', 143); };
    const protocol = new AcpSession(child as unknown as ChildProcessWithoutNullStreams, { permissions: 'auto',
        promptTimeoutMs: 2000, controlTimeoutMs: 1000, ownedProcessOptions: { terminateTree: () => queueMicrotask(exit) } });
    await protocol.start({ cwd: process.cwd() });
    const runtime = new AcpRuntimeSession(protocol, { provider: 'fixture-acp', deferTurnEnd: true,
        capabilities: { transport: 'native', steer: 'restart', resume: false, tools: true, toolOutput: true,
            approvals: true, questions: false, images: false, subagents: false },
        getTurnContext: () => ({ runId: 'run', sessionId: 'jaw', scope: 'scope', turnId: 'logical', audience: 'internal', isCurrent: () => current }),
        createReplacement: io => new AcpReplacement(io),
        resultUsage: result => result['_meta'] ? { kind: 'usage', outputTokens: 3 } : null,
        record: (context, body) => {
            if (!record) return null;
            const value = { ...context, version: 1 as const, seq: events.length + 1, ...body };
            events.push(value); return value;
        }, ...patch,
    });
    t.after(async () => { await runtime.close(); heldWrite?.(); });
    const run = () => { const result = runtime.send({ text: 'A' }, () => {}); void result.catch(() => {}); return result; };
    return { runtime, protocol, wire, events, order, child, run, send, reply, update, finish,
        earlyResult: () => { responseBeforeWrite = true; }, invalidate: () => { current = false; },
        noRecord: () => { record = false; }, failCancel: () => { failCancel = true; },
        holdWrites: () => { writesHeld = true; }, releaseWrite: () => { heldWrite?.(); heldWrite = undefined; writesHeld = false; },
        holdCancel: () => { holdCancel = true; }, releaseCancel: () => { cancelReply?.(); }, lateText: (value: string) => { lateText = value; },
    };
}

test('only the injected replacement strategy advertises cancel-reprompt', async t => {
    const f = await fixture(t); assert.equal(f.runtime.capabilities.steer, 'cancel-reprompt');
    const noStart = await f.runtime.steer({ text: 'B' });
    assert.equal(noStart.accepted, false); assert.equal(noStart.mode, 'cancel-reprompt');
});

test('same logical turn replaces A and claims/finalizes B once with complete partial', async t => {
    const f = await fixture(t), run = f.run(); await tick();
    let committed = 0;
    const accepted = await f.runtime.steer({ text: 'B' }, () => { committed++; f.order.push('input'); });
    assert.equal(accepted.accepted, true); assert.equal(accepted.mode, 'cancel-reprompt'); assert.equal(committed, 1);
    const result = await run;
    assert.deepEqual(result, { status: 'done', finalText: 'B_FINAL', partialText: 'A_PARTIALB_FINAL' });
    assert.equal(f.wire.filter(row => row.method === 'session/prompt').length, 2);
    assert.equal(f.wire.filter(row => row.method === 'session/prompt')[1]!.params!.prompt[0].text, 'B');
    assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 0);
    assert.deepEqual(f.runtime.claimTurnOutcome('logical'), result);
    assert.equal(f.runtime.finalizeTurn('logical', { kind: 'turn-end', status: 'done', finalText: result.finalText }), true);
    assert.equal(f.runtime.finalizeTurn('logical', { kind: 'turn-end', status: 'done', finalText: 'duplicate' }), false);
    assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 1);
});

test('a fast B result waits the synchronous input commit barrier', async t => {
    const f = await fixture(t); f.earlyResult(); let finished = false;
    const run = f.run().then(result => { finished = true; f.order.push('result'); return result; }); await tick();
    await f.runtime.steer({ text: 'B' }, () => { assert.equal(finished, false); f.order.push('input'); });
    await run; assert.ok(f.order.indexOf('input') < f.order.indexOf('result'));
});

test('input commit failure after local dispatch is fatal without retry and preserves partial', async t => {
    const f = await fixture(t); f.earlyResult(); const run = f.run(); await tick(); let attempts = 0;
    await assert.rejects(f.runtime.steer({ text: 'B' }, () => { attempts++; throw new Error('insert failed'); }), /observer/);
    const result = await run;
    assert.equal(attempts, 1); assert.equal(result.status, 'error'); assert.equal(result.finalText, null);
    assert.match(result.partialText, /A_PARTIAL/); assert.equal(f.protocol.alive, false);
    assert.equal(f.wire.filter(row => row.method === 'session/prompt').length, 2);
});

test('cancellation failure rejects the steer and never sends a replacement', async t => {
    const f = await fixture(t); f.failCancel(); const run = f.run(); await tick(); let committed = 0;
    await assert.rejects(f.runtime.steer({ text: 'B' }, () => { committed++; }));
    const outcome = await run; assert.equal(outcome.status, 'error'); assert.equal(committed, 0);
    assert.equal(f.wire.filter(row => row.method === 'session/prompt').length, 1);
    assert.equal(outcome.partialText, 'A_PARTIAL');
});

test('explicit stop during pending replacement settles stopped without input commit', async t => {
    const f = await fixture(t); const run = f.run(); await tick(); let commits = 0;
    const steering = f.runtime.steer({ text: 'B' }, () => { commits++; });
    await f.runtime.cancel(); const result = await run; const acceptance = await steering;
    assert.equal(result.status, 'stopped'); assert.equal(result.finalText, null);
    assert.equal(acceptance.accepted, false); assert.equal(commits, 0);
});

test('recording failure does not suppress latest final, partial or local dispatch fact', async t => {
    const f = await fixture(t); f.noRecord(); const run = f.run(); await tick(); let commits = 0;
    assert.equal((await f.runtime.steer({ text: 'B' }, () => { commits++; })).accepted, true);
    const result = await run; assert.equal(result.finalText, 'B_FINAL'); assert.equal(result.partialText, 'A_PARTIALB_FINAL');
    assert.equal(commits, 1); assert.equal(f.events.length, 0); assert.equal(f.runtime.claimTurnOutcome('logical')?.status, 'done');
});

test('no active raw prompt, stale owner and unsupported prompt cannot cancel or commit input', async t => {
    const f = await fixture(t); let commits = 0;
    assert.equal((await f.runtime.steer({ text: 'B' }, () => { commits++; })).accepted, false);
    const run = f.run(); await tick();
    await assert.rejects(f.runtime.steer({ text: 'bad', images: [{ mimeType: 'image/png', data: 'x' }] }), /unsupported/);
    f.invalidate(); assert.equal((await f.runtime.steer({ text: 'B' }, () => { commits++; })).accepted, false);
    assert.equal(f.wire.filter(row => row.method === 'session/cancel').length, 0); assert.equal(commits, 0);
    await f.runtime.cancel(); await run;
});

test('a completed raw result cannot be treated as cancellation acknowledgement during a result observer', async t => {
    const f = await fixture(t), calls: Array<Promise<unknown>> = [];
    const run = f.runtime.send({ text: 'A' }, event => {
        if (event.kind === 'message' && event.phase === 'final') calls.push(f.runtime.steer({ text: 'late' }));
    });
    await tick(); f.finish(); await run;
    const outcomes = await Promise.all(calls) as Array<{ accepted: boolean }>;
    assert.ok(outcomes.length); assert.ok(outcomes.every(value => !value.accepted));
    assert.equal(f.wire.filter(row => row.method === 'session/prompt').length, 1);
});

test('app single-flight keeps B first and returns busy for C without cancelling or committing C', async t => {
    const f = await fixture(t); f.holdCancel(); const run = f.run(); await tick();
    let bCommits = 0, cCommits = 0;
    const b = f.runtime.steer({ text: 'B' }, () => { bCommits++; });
    const c = await f.runtime.steer({ text: 'C' }, () => { cCommits++; });
    assert.equal(c.accepted, false); assert.equal(c.reason, 'busy');
    assert.equal(f.wire.filter(row => row.method === 'session/cancel').length, 1);
    f.releaseCancel(); assert.equal((await b).accepted, true); await run;
    assert.equal(bCommits, 1); assert.equal(cCommits, 0);
    assert.equal(f.wire.filter(row => row.method === 'session/prompt')[1]!.params!.prompt[0].text, 'B');
});

test('prepare runs after drained partial and changes only the wire prompt, not committed user instruction', async t => {
    const prepared: Array<[string, string]> = [], committed: string[] = [];
    const f = await fixture(t, { prepareReplacement: (instruction, partial) => {
        prepared.push([instruction, partial]); return { text: 'SYS ORIGINAL PARTIAL=' + partial + ' NEW=' + instruction };
    } });
    f.lateText('_LATE'); const run = f.run(); await tick(); assert.equal(prepared.length, 0);
    await f.runtime.steer({ text: 'B' }, () => committed.push('B')); await run;
    assert.deepEqual(prepared, [['B', 'A_PARTIAL_LATE']]); assert.deepEqual(committed, ['B']);
    const requests = f.wire.filter(row => row.method === 'session/prompt');
    assert.equal(requests[0]!.params!.prompt[0].text, 'A');
    assert.equal(requests[1]!.params!.prompt[0].text, 'SYS ORIGINAL PARTIAL=A_PARTIAL_LATE NEW=B');
});

test('Stop reentered by prepare prevents B without killing an idle reusable protocol', async t => {
    let f: Awaited<ReturnType<typeof fixture>>, cancel: Promise<void> | undefined, committed = 0;
    f = await fixture(t, { prepareReplacement: () => { cancel = f.runtime.cancel(); return { text: 'B' }; } });
    const run = f.run(); await tick(); const steering = f.runtime.steer({ text: 'B' }, () => { committed++; });
    const accepted = await steering; await cancel; const result = await run;
    assert.equal(accepted.accepted, false); assert.equal(result.status, 'stopped'); assert.equal(committed, 0);
    assert.equal(f.wire.filter(row => row.method === 'session/prompt').length, 1); assert.equal(f.protocol.alive, true);
});

for (const kind of ['throw', 'invalid', 'async'] as const) test(`preparation ${kind} is fatal after cancellation and never dispatches B`, async t => {
    const prepare = (() => {
        if (kind === 'throw') throw new Error('private prepare failure');
        if (kind === 'async') return Promise.reject(new Error('private async prepare failure'));
        return { text: 123 };
    }) as unknown as NonNullable<ConstructorParameters<typeof AcpRuntimeSession>[1]['prepareReplacement']>;
    const f = await fixture(t, { prepareReplacement: prepare }); const run = f.run(); await tick(); let commits = 0;
    await assert.rejects(f.runtime.steer({ text: 'B' }, () => { commits++; }));
    assert.equal((await run).status, 'error'); assert.equal(commits, 0); assert.equal(f.protocol.alive, false);
    assert.equal(f.wire.filter(row => row.method === 'session/prompt').length, 1);
});

test('prepared output is snapshotted before a queued mutation and ownership is rechecked', async t => {
    const f = await fixture(t, { prepareReplacement: () => {
        const prepared = { text: 'COMPOSED' }; queueMicrotask(() => { prepared.text = 'mutated'; }); return prepared;
    } });
    const run = f.run(); await tick(); await f.runtime.steer({ text: 'B' }); await run;
    assert.equal(f.wire.filter(row => row.method === 'session/prompt')[1]!.params!.prompt[0].text, 'COMPOSED');
    let stale: Awaited<ReturnType<typeof fixture>>;
    stale = await fixture(t, { prepareReplacement: () => { stale.invalidate(); return { text: 'B' }; } });
    const stopped = stale.run(); await tick(); await assert.rejects(stale.runtime.steer({ text: 'B' })); await stopped;
    assert.equal(stale.wire.filter(row => row.method === 'session/prompt').length, 1);
});

test('async input commit is consumed and fails closed instead of releasing a successful final', async t => {
    const f = await fixture(t); f.earlyResult(); const run = f.run(); await tick();
    await assert.rejects(f.runtime.steer({ text: 'B' }, () => Promise.reject(new Error('private commit failure'))), /observer/);
    const result = await run; assert.equal(result.status, 'error'); assert.equal(result.finalText, null);
    assert.equal(f.protocol.alive, false);
});
