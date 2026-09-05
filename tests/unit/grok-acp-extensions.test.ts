import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpSession } from '../../src/agent/runtime/acp/session.ts';

type Wire = { id?: string; method?: string; params?: Record<string, unknown>; error?: { code: number } };
function fixture(t: TestContext) {
    const writes: Wire[] = [];
    const child = Object.assign(new EventEmitter(), { pid: 48001, exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable() });
    const send = (frame: unknown) => child.stdout.write(JSON.stringify(frame) + '\n');
    const reply = (frame: Wire, result: unknown) => send({ jsonrpc: '2.0', id: frame.id, result });
    child.stdin = new Writable({ write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk)) as Wire; writes.push(frame);
        if (frame.method === 'initialize') reply(frame, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
        if (frame.method === 'session/new') reply(frame, { sessionId: 'grok-native' });
        done();
    } });
    const exit = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 143; child.emit('exit', 143, null); child.emit('close', 143, null);
    };
    const session = new AcpSession(child as unknown as ChildProcessWithoutNullStreams, {
        permissions: 'safe', promptTimeoutMs: 1000, requestTimeoutMs: 1000, controlTimeoutMs: 1000,
        ownedProcessOptions: { terminateTree: () => queueMicrotask(exit) },
    });
    let turn = 0;
    const prompt = (consume: (frame: unknown) => void = () => {}) => session.prompt([{ type: 'text', text: 'fixture' }], {
        binding: { runId: 'jaw-run', sessionId: 'jaw-chat', scope: 'scope', turnId: 'turn-' + (++turn) },
        isCurrent: () => true, emit: () => null,
    }, consume);
    const extension = (params: unknown) => send({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params });
    const current = () => writes.filter(frame => frame.method === 'session/prompt').at(-1)!;
    t.after(() => session.close());
    return { session, writes, send, reply, prompt, extension, current };
}

test('session-only, foreign and duplicate Grok completions never settle the original prompt', async t => {
    const f = fixture(t); await f.session.start({ cwd: process.cwd() });
    let settled = false;
    const prompt = f.prompt().then(value => { settled = true; return value; });
    const frames = [{ sessionId: 'grok-native', stopReason: 'end_turn' },
        { sessionId: 'other-native', promptId: 'old', stopReason: 'end_turn' },
        { sessionId: 'grok-native', promptId: 'old', stopReason: 'end_turn', agentResult: 'not authoritative' }];
    for (const params of frames) { f.extension(params); f.extension(params); }
    await nextTurn(); assert.equal(settled, false); assert.equal(f.session.idle, false);
    f.reply(f.current(), { stopReason: 'max_tokens' });
    assert.equal((await prompt)['stopReason'], 'max_tokens'); assert.equal(f.session.idle, true);
});

test('cancel requires original response and a late old completion cannot terminate the replacement', async t => {
    const f = fixture(t); await f.session.start({ cwd: process.cwd() });
    const seen: unknown[] = [];
    const first = f.prompt(frame => { seen.push(frame); }), original = f.current();
    let cancelled = false;
    const cancel = f.session.cancel().then(() => { cancelled = true; });
    f.extension({ sessionId: 'grok-native', promptId: 'A', stopReason: 'cancelled' });
    await nextTurn(); assert.equal(cancelled, false);
    assert.deepEqual(f.writes.find(frame => frame.method === 'session/cancel'), {
        jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'grok-native' },
    });
    f.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-native', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'A-tool', status: 'completed', rawOutput: 'old-drained',
    } } });
    f.reply(original, { stopReason: 'cancelled' });
    await Promise.all([first, cancel]); assert.equal(seen.length, 1);
    let settled = false;
    const second = f.prompt().then(value => { settled = true; return value; });
    assert.notEqual(f.current().id, original.id);
    f.extension({ sessionId: 'grok-native', promptId: 'A', stopReason: 'end_turn' });
    f.extension({ sessionId: 'grok-native', stopReason: 'error' });
    await nextTurn(); assert.equal(settled, false); assert.equal(f.session.alive, true);
    f.reply(f.current(), { stopReason: 'end_turn' }); await second;
});

test('unproven question and plan extensions are refused through the common callback boundary', async t => {
    const f = fixture(t); await f.session.start({ cwd: process.cwd() });
    const prompt = f.prompt();
    for (const method of ['_x.ai/ask_user_question', 'x.ai/ask_user_question', '_x.ai/exit_plan_mode', '_x.ai/fs/read_file']) {
        f.send({ jsonrpc: '2.0', id: method, method, params: { sessionId: 'grok-native', toolCallId: 'tool',
            questions: [{ question: 'untrusted', options: [{ label: 'allow' }] }] } });
    }
    await nextTurn();
    const replies = f.writes.filter(frame => frame.error);
    assert.equal(replies.length, 4); assert.equal(replies.every(frame => frame.error!.code === -32601), true);
    assert.equal(f.session.alive, true);
    f.reply(f.current(), { stopReason: 'end_turn' }); await prompt;
});
