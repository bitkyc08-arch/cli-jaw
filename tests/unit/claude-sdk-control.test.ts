import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeClose } from '../../src/agent/runtime/claude-sdk-close.ts';
// Recorders are injected here; module loading must not initialize shared SQLite.
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => null } });
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');

test('close latches before reentrant callbacks and awaits the actual barrier', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = []; let reentered;
    const close = createClaudeClose({ timeoutMs: 100,
        fence: () => { order.push('fence'); reentered = close(); },
        startTermination: () => { order.push('terminate'); }, settlePending: () => { order.push('settle'); },
        readerDone: () => barrier, onClosed: () => { order.push('closed'); } });
    const first = close(); assert.equal(first, reentered); assert.equal(first, close());
    assert.deepEqual(order, ['fence', 'terminate', 'settle']);
    release(); await first; assert.deepEqual(order, ['fence', 'terminate', 'settle', 'closed']);
});
test('all thrown values reject cleanup without stranding local pending settlement', async () => {
    for (const thrown of [undefined, null, false, 0, new Error('private secret')]) {
        let settled = false, closed = false, waited = false;
        const close = createClaudeClose({ timeoutMs: 100, fence() {}, startTermination() { throw thrown; },
            settlePending() { settled = true; }, readerDone: async () => { waited = true; }, onClosed() { closed = true; } });
        await assert.rejects(close(), /claude_close_failed/);
        assert.equal(settled, true); assert.equal(waited, true); assert.equal(closed, false);
    }
});
test('fence or settlement errors do not skip termination and barrier', async () => {
    for (const where of ['fence', 'settle']) {
        let terminated = false, waited = false;
        const close = createClaudeClose({ timeoutMs: 100,
            fence() { if (where === 'fence') throw new Error('private'); },
            startTermination() { terminated = true; },
            settlePending() { if (where === 'settle') throw new Error('private'); },
            readerDone: async () => { waited = true; } });
        await assert.rejects(close(), /claude_close_failed/); assert.ok(terminated && waited);
    }
});
test('never-ending or rejected barrier cannot claim successful close', async () => {
    for (const reject of [false, true]) {
        let closed = false;
        const close = createClaudeClose({ timeoutMs: 10, fence() {}, startTermination() {}, settlePending() {},
            readerDone: () => reject ? Promise.reject(new Error('private')) : new Promise(() => {}), onClosed() { closed = true; } });
        await assert.rejects(close(), /claude_close_(timeout|failed)/); assert.equal(closed, false);
        await assert.rejects(close(), /claude_close_(timeout|failed)/);
    }
});
test('successful close clears its timer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let closed = 0;
    const close = createClaudeClose({ timeoutMs: 100, fence() {}, startTermination() {}, settlePending() {},
        readerDone: async () => {}, onClosed() { closed++; } });
    await close(); t.mock.timers.tick(1000); await close(); assert.equal(closed, 1);
});

async function sessionFixture(id: string, closeError = false) {
    const frames: unknown[] = []; let wake: (() => void) | undefined, stopped = false, offered = 0, closed = 0;
    const output = async function* () { while (!stopped) { if (frames.length) yield frames.shift(); else await new Promise<void>(resolve => { wake = resolve; }); } };
    const push = (frame: unknown) => { frames.push(frame); wake?.(); wake = undefined; };
    const session = await createClaudeSdkSession({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 1000, closeTimeoutMs: 100,
        getTurnContext: () => ({ runId: id, sessionId: id, scope: id, turnId: id, audience: 'internal', isCurrent: () => true }),
        record: () => null,
        queryFactory: ({ prompt }) => {
            void (async () => { for await (const _message of prompt) offered++; })();
            return { [Symbol.asyncIterator]: output, close() { closed++; stopped = true; wake?.(); if (closeError) throw undefined; } };
        },
    });
    return { session, push, get offered() { return offered; }, get closed() { return closed; } };
}
test('Stop after input yield closes exactly once and leaves independent session running', async () => {
    const a = await sessionFixture('a'), b = await sessionFixture('b');
    const first = a.session.send({ text: 'a' }, () => {}), second = b.session.send({ text: 'b' }, () => {});
    await new Promise(resolve => setImmediate(resolve)); assert.equal(a.offered, 1);
    a.push({ type: 'system', subtype: 'init', session_id: 'native-a', permissionMode: 'default' });
    await new Promise(resolve => setImmediate(resolve));
    await a.session.cancel(); assert.equal((await first).status, 'stopped');
    assert.equal(a.session.nativeSessionId, 'native-a'); assert.equal(b.session.alive, true);
    b.push({ type: 'result', subtype: 'success', is_error: false, result: 'b answer' });
    assert.equal((await second).finalText, 'b answer'); await b.session.close();
    assert.equal(a.closed, 1); assert.equal(b.closed, 1);
});
test('terminal committed before Stop remains done while falsy close failure rejects cleanup', async () => {
    const f = await sessionFixture('done', true);
    const turn = f.session.send({ text: 'a' }, () => {});
    f.push({ type: 'result', subtype: 'success', is_error: false, result: 'final' });
    assert.equal((await turn).status, 'done');
    await assert.rejects(f.session.close(), /claude_close_failed/); assert.equal(f.closed, 1);
});
test('already-aborted acquisition never creates a query', async () => {
    const signal = AbortSignal.abort(); let factories = 0;
    await assert.rejects(createClaudeSdkSession({ signal,
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 100, getTurnContext: () => { throw new Error('unreachable'); },
        queryFactory: () => { factories++; throw new Error('unreachable'); },
    }), /claude_acquire_aborted/);
    assert.equal(factories, 0);
});
