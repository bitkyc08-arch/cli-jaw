import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';
import { AcpSession } from '../../src/agent/runtime/acp/session.ts';
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => { throw new Error('Unexpected default database'); } } });
const { AcpRuntimeSession } = await import('../../src/agent/runtime/acp/runtime-session.ts');

type Wire = Record<string, any>;
let serial = 0;
async function fixture(t: TestContext, patch: Partial<ConstructorParameters<typeof AcpRuntimeSession>[1]> = {}, permissions = 'auto') {
    const child = Object.assign(new EventEmitter(), { pid: 60000 + (++serial), exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable() });
    const writes: Wire[] = [], events: RuntimeEvent[] = [], notices = new EventEmitter();
    let promptId: unknown, current = true, seq = 0, recordMode = 'ok';
    let context = { runId: 'run-1', sessionId: 'chat', scope: 'scope', turnId: 'turn-1', audience: 'internal' as const,
        isCurrent: () => current };
    const send = (value: unknown) => { if (child.exitCode === null) child.stdout.write(JSON.stringify(value) + '\n'); };
    const reply = (id: unknown, result: unknown) => setImmediate(() => send({ jsonrpc: '2.0', id, result }));
    const update = (text: string) => send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'fixture-native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    let onPrompt: (message: Wire) => void = message => { update('answer'); reply(message.id, { stopReason: 'end_turn' }); };
    let onReply: (message: Wire) => void = () => {};
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk)); writes.push(message);
        if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
        else if (message.method === 'session/new') reply(message.id, { sessionId: 'fixture-native' });
        else if (message.method === 'session/prompt') { promptId = message.id; onPrompt(message); }
        else if (message.method === 'session/cancel') reply(promptId, { stopReason: 'cancelled' });
        else onReply(message);
        callback(); notices.emit('change');
    } });
    const exit = () => { if (child.exitCode !== null) return; child.exitCode = 143; child.emit('exit', 143); child.emit('close', 143); };
    const registry = new RuntimeRequests();
    const protocol = new AcpSession(child as unknown as ChildProcessWithoutNullStreams, {
        permissions, registry, promptTimeoutMs: 1000,
        ownedProcessOptions: { terminateTree: () => queueMicrotask(exit) },
    });
    await protocol.start({ cwd: process.cwd() });
    const runtime = new AcpRuntimeSession(protocol, { provider: 'cursor', deferTurnEnd: true, registry,
        capabilities: { transport: 'native', steer: 'restart', resume: true, tools: true, toolOutput: true,
            approvals: true, questions: false, images: false, subagents: false },
        getTurnContext: () => context,
        record: (owner, body) => {
            if (recordMode === 'throw') throw new Error('private writer failure');
            if (recordMode === 'null') return null;
            const event: RuntimeEvent = { ...owner, version: 1, seq: seq += 3, ...body };
            events.push(event); return event;
        }, ...patch });
    t.after(async () => { await runtime.close(); notices.removeAllListeners(); });
    return { runtime, protocol, child, events, writes, registry, update, send, reply, exit,
        run: (observer: (event: RuntimeEvent) => void = () => {}) => runtime.send({ text: 'fixture prompt' }, observer),
        onPrompt: (value: typeof onPrompt) => { onPrompt = value; }, onReply: (value: typeof onReply) => { onReply = value; },
        invalidate: () => { current = false; }, recordMode: (mode: string) => { recordMode = mode; },
        context: () => context, next: () => { context = { ...context, runId: 'run-2', turnId: 'turn-2' }; },
        waitFor: (predicate: () => boolean) => predicate() ? Promise.resolve() : new Promise<void>(resolve => {
            const check = () => { if (predicate()) { notices.off('change', check); resolve(); } }; notices.on('change', check);
        }),
    };
}

test('real protocol fixture keeps commentary/tools separate from the full terminal candidate', async t => {
    const f = await fixture(t);
    const data = JSON.parse(readFileSync(new URL('../fixtures/grok-acp-read-file.json', import.meta.url), 'utf8'));
    f.onPrompt(message => { for (const frame of data.frames) f.send(frame); f.reply(message.id, data.result); });
    const outcome = await f.run();
    assert.equal(outcome.finalText, data.expectedFinal);
    assert.match(outcome.partialText, /I'll read/);
    assert.ok(f.events.some(e => e.kind === 'tool'));
    assert.equal(f.events.some(e => e.kind === 'turn-end'), false);
    assert.equal(f.runtime.idle, false);
    const claim = f.runtime.claimTurnOutcome('turn-1');
    assert.deepEqual(claim, outcome); assert.equal(f.runtime.claimTurnOutcome('turn-1'), claim);
    assert.equal(f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'done', finalText: 'application final' }), true);
    assert.equal(f.events.at(-1)?.kind, 'turn-end');
    assert.equal((f.events.at(-1) as Extract<RuntimeEvent, { kind: 'turn-end' }>).finalText, 'application final');
    assert.equal(f.runtime.idle, true);
});
for (const text of [null, '', ' \n\t ', 'x'.repeat(50_000)]) test(`absent/empty/full answer is independent of preview length: ${text === null ? 'null' : text.length}`, async t => {
    const f = await fixture(t);
    f.onPrompt(message => { if (text !== null) f.update(text); f.reply(message.id, { stopReason: 'end_turn' }); });
    const result = await f.run(); assert.equal(result.finalText, text);
    if (text && text.length > 3000) assert.ok(f.events.filter(e => e.kind === 'message').every(e => e.text.length <= 3000));
});
for (const mode of ['null', 'throw']) test(`record ${mode} cannot destroy final or partial`, async t => {
    const f = await fixture(t); f.recordMode(mode);
    const outcome = await f.run();
    assert.deepEqual(outcome, { status: 'done', finalText: 'answer', partialText: 'answer' });
    assert.equal(f.events.length, 0); assert.ok(f.runtime.claimTurnOutcome('turn-1'));
    assert.equal(f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'done', finalText: 'answer' }), true);
});
test('canonical usage hook and throwing observer are optional, never a whole-send error', async t => {
    const f = await fixture(t, { resultUsage: () => ({ kind: 'usage', inputTokens: 0, outputTokens: 12, cachedTokens: 3 }) });
    const result = await f.run(() => { throw new Error('observer'); });
    assert.equal(result.finalText, 'answer');
    const usage = f.events.find(e => e.kind === 'usage');
    assert.ok(usage && usage.kind === 'usage'); assert.equal(usage.inputTokens, 0); assert.equal(usage.cachedTokens, 3);
    const bad = await fixture(t, { resultUsage: () => { throw new Error('optional usage'); } });
    assert.equal((await bad.run()).status, 'done');
});
test('send captures context once and rejects cross-owner reuse', async t => {
    const f = await fixture(t); let reads = 0;
    const original = f.context();
    f.onPrompt(message => { original.runId = 'mutated'; f.update('answer'); f.reply(message.id, { stopReason: 'end_turn' }); });
    await f.run(() => { reads++; }); assert.ok(reads > 0);
    assert.ok(f.events.every(e => e.runId === 'run-1'));
    assert.ok(f.runtime.claimTurnOutcome('turn-1'));
    f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'done', finalText: 'answer' });
    original.scope = 'foreign';
    await assert.rejects(f.run(), /owner_changed/);
});
test('deferred finalization requires exact claim, blocks reuse, and a late old token cannot end B', async t => {
    const f = await fixture(t); await f.run();
    assert.equal(f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'done', finalText: 'bad' }), false);
    assert.equal(f.runtime.claimTurnOutcome('foreign'), null);
    await assert.rejects(f.run(), /busy/);
    f.runtime.claimTurnOutcome('turn-1');
    f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'done', finalText: 'answer' });
    f.next(); await f.run();
    assert.equal(f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'done', finalText: 'old' }), false);
    assert.equal(f.runtime.claimTurnOutcome('turn-2')?.status, 'done');
});
test('stop before claim survives removed main ownership and cannot upgrade back to done', async t => {
    const f = await fixture(t); await f.run(); f.invalidate(); await f.runtime.cancel();
    assert.equal(f.runtime.claimTurnOutcome('turn-1')?.status, 'stopped');
    assert.equal(f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'done', finalText: 'bad' }), false);
    assert.equal(f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'stopped', finalText: null }), true);
});
test('late protocol failure before claim downgrades but after claim cannot rewrite the accepted result', async t => {
    const before = await fixture(t); await before.run(); before.protocol.retire();
    assert.deepEqual(before.runtime.claimTurnOutcome('turn-1'), { status: 'error', finalText: null, partialText: 'answer' });
    const after = await fixture(t); await after.run(); const claim = after.runtime.claimTurnOutcome('turn-1');
    after.protocol.retire(); assert.equal(after.runtime.claimTurnOutcome('turn-1'), claim);
    assert.equal(after.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'done', finalText: 'answer' }), true);
    assert.equal(after.runtime.alive, false);
});
test('real cancellation yields stopped partial and subsequent distinct turn can reuse protocol', async t => {
    const f = await fixture(t); f.onPrompt(() => { f.update('partial'); });
    const pending = f.run(); await new Promise<void>(resolve => setImmediate(resolve));
    await f.runtime.cancel(); const outcome = await pending;
    assert.deepEqual(outcome, { status: 'stopped', finalText: null, partialText: 'partial' });
    f.runtime.claimTurnOutcome('turn-1'); f.runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'stopped', finalText: null });
    f.next(); f.onPrompt(message => { f.update('next'); f.reply(message.id, { stopReason: 'end_turn' }); });
    assert.equal((await f.run()).finalText, 'next');
});
test('model error and early process exit preserve accepted partial without final fallback', async t => {
    const max = await fixture(t); max.onPrompt(message => { max.update('incomplete'); max.reply(message.id, { stopReason: 'max_tokens' }); });
    assert.deepEqual(await max.run(), { status: 'error', finalText: null, partialText: 'incomplete' });
    const gone = await fixture(t); gone.onPrompt(() => { gone.update('accepted'); });
    const run = gone.run(); await new Promise<void>(resolve => setImmediate(resolve)); gone.exit();
    assert.deepEqual(await run, { status: 'error', finalText: null, partialText: 'accepted' });
});
test('permission response uses the captured exact owner and never accepts a stale caller', async t => {
    const f = await fixture(t, {}, 'safe'); let promptId: unknown;
    f.onPrompt(message => { promptId = message.id; f.send({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: {
        sessionId: 'fixture-native', toolCall: { toolCallId: 'native-tool', title: 'Read' },
        options: [{ optionId: 'native-allow', kind: 'allow_once', name: 'Allow' }],
    } }); });
    f.onReply(message => { if (message.id === 'permission') f.reply(promptId, { stopReason: 'end_turn' }); });
    const run = f.run(); const request = f.registry.list('chat')[0]!;
    await f.runtime.respond(request.requestId, { optionId: request.view.fields[0]!.options[0]!.id });
    await run; assert.equal(f.writes.find(x => x.id === 'permission')!.result.outcome.optionId, 'native-allow');
    await assert.rejects(f.runtime.respond(request.requestId, { optionId: null }), /request_not_current/);
});
test('invalid context and unsupported images reject before prompt dispatch', async t => {
    const f = await fixture(t); f.context().scope = 'x'.repeat(241);
    await assert.rejects(f.run(), /invalid_owner/);
    await assert.rejects(f.runtime.send({ text: 'x', images: [{ mimeType: 'image/png', data: 'abc' }] }, () => {}), /prompt_unsupported/);
    assert.equal(f.writes.some(x => x.method === 'session/prompt'), false);
});
test('synchronous start observer cancellation never admits a prompt and standalone terminal cannot reenter', async t => {
    const f = await fixture(t); let cancel: Promise<void> | undefined;
    const result = await f.run(event => { if (event.kind === 'turn-start') cancel = f.runtime.cancel(); });
    await cancel; assert.equal(result.status, 'stopped');
    assert.equal(f.writes.some(x => x.method === 'session/prompt'), false);
    const plain = await fixture(t, { deferTurnEnd: false }); let reentry: Promise<unknown> | undefined;
    await plain.run(event => { if (event.kind === 'turn-end') reentry = assert.rejects(plain.run(), /busy/); });
    await reentry; assert.equal(plain.events.filter(e => e.kind === 'turn-end').length, 1);
});
