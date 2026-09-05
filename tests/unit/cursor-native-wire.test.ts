import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { launchControlAgent } from '../fixtures/native-acp-control.mjs';
import { AcpSession } from '../../src/agent/runtime/acp/session.ts';
import { AcpRuntimeSession } from '../../src/agent/runtime/acp/runtime-session.ts';
import { AcpReplacement } from '../../src/agent/runtime/acp/replacement.ts';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';

async function fixture(t: TestContext, mode = 'held') {
    const peer = launchControlAgent(process.env.CLI_JAW_HOME!, mode);
    // The IPC fd is additional to three non-null pipes; spawn's overload loses that fact.
    const child = peer.child as ChildProcessWithoutNullStreams;
    const chunks: string[] = [];
    child.stdout.on('data', chunk => chunks.push(String(chunk)));
    const protocol = new AcpSession(child, { permissions: 'auto', promptTimeoutMs: 5000,
        requestTimeoutMs: 2000, controlTimeoutMs: 600, drainTimeoutMs: 2000 });
    t.after(async () => { await protocol.close(); await peer.exited; assert.notEqual(child.exitCode ?? child.signalCode, null); });
    await protocol.start({ cwd: process.env.CLI_JAW_HOME!, authMethodId: 'cursor_login' });
    const events: RuntimeEvent[] = [], prepared: string[] = [];
    const partial = Promise.withResolvers<void>();
    const runtime = new AcpRuntimeSession(protocol, {
        provider: 'cursor', deferTurnEnd: true,
        capabilities: { transport: 'native', steer: 'restart', resume: true, tools: true, toolOutput: true,
            approvals: false, questions: false, images: false, subagents: false },
        getTurnContext: () => ({ runId: 'wire-run', sessionId: 'jaw-session', scope: 'wire-scope',
            turnId: 'logical-turn', audience: 'internal', isCurrent: () => true }),
        createReplacement: io => new AcpReplacement(io),
        prepareReplacement: (instruction, text) => {
            assert.equal(protocol.idle, true); prepared.push(text); return { text: instruction };
        },
        record: (context, body) => {
            const event = { ...context, version: 1 as const, seq: events.length + 1, ...body };
            events.push(event); if (body.kind === 'message') partial.resolve(); return event;
        },
    });
    const prompts = () => peer.records.filter(row => row.kind === 'prompt');
    const start = async () => {
        const result = runtime.send({ text: 'A' }, () => {});
        await partial.promise; await peer.waitFor(row => row.kind === 'prompt');
        return { result };
    };
    return { ...peer, child, chunks, protocol, runtime, events, prepared, prompts, start };
}

for (const mode of ['missing-cancel', 'exit-on-cancel', 'noncancelled', 'illegal-chunk']) {
    test(`owned Node ${mode} retires with one error result and no B dispatch`, { timeout: 8000 }, async t => {
        const f = await fixture(t, mode), { result } = await f.start();
        let commits = 0;
        await assert.rejects(f.runtime.steer({ text: 'B' }, () => { commits++; }));
        const outcome = await result;
        assert.equal(outcome.status, 'error'); assert.equal(outcome.finalText, null);
        assert.match(outcome.partialText, /PARTIAL_1/); assert.equal(commits, 0);
        assert.equal(f.prompts().length, 1); assert.equal(f.protocol.alive, false);
        assert.equal(f.runtime.claimTurnOutcome('logical-turn')?.status, 'error');
        assert.equal(f.runtime.finalizeTurn('logical-turn', { kind: 'turn-end', status: 'error', finalText: null }), true);
        assert.equal(f.runtime.finalizeTurn('logical-turn', { kind: 'turn-end', status: 'error', finalText: null }), false);
        assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 1);
        await f.exited;
        if (mode === 'exit-on-cancel') assert.equal(f.child.exitCode, 23);
        if (mode === 'missing-cancel') assert.equal(f.runtime.lastError, 'acp_cancel_timeout');
        if (mode === 'illegal-chunk') {
            assert.equal(f.runtime.lastError, 'acp_content_without_active_turn');
            assert.ok(f.chunks.some(chunk => chunk.includes('"stopReason":"cancelled"') && chunk.includes('ILLEGAL_AFTER_TERMINAL')));
        }
    });
}

test('real stdio holds B until original cancelled RPC, consumer drain and actual idle; one final', { timeout: 8000 }, async t => {
    const f = await fixture(t), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const original = f.protocol.prompt.bind(f.protocol);
    t.after(() => gate.resolve());
    t.mock.method(f.protocol, 'prompt', (parts, owner, consume, options) => original(parts, owner, async (frame, signal) => {
        if (JSON.stringify(frame).includes('_LATE_1')) { entered.resolve(); await gate.promise; }
        return consume(frame, signal);
    }, options));
    const { result } = await f.start(); let settled = false, commits = 0;
    void result.then(() => { settled = true; });
    const steering = f.runtime.steer({ text: 'B' }, () => { commits++; assert.equal(settled, false); });
    await f.waitFor(row => row.kind === 'cancel');
    assert.equal(f.prompts().length, 1); assert.equal(settled, false);
    await f.command('release-cancel'); await entered.promise;
    assert.equal(f.protocol.idle, false); assert.equal(f.prompts().length, 1);
    assert.equal(commits, 0); assert.equal(f.prepared.length, 0);
    assert.equal(f.events.some(event => event.kind === 'turn-end'), false);
    gate.resolve(); assert.equal((await steering).accepted, true);
    await f.waitFor(row => row.kind === 'prompt' && row.index === 2);
    assert.deepEqual(f.prepared, ['PARTIAL_1_LATE_1']);
    assert.equal(f.events.some(event => event.kind === 'tool'), true);
    assert.equal(settled, false); assert.equal(commits, 1);
    await f.command('finish', { text: 'B_FINAL' });
    const outcome = await result;
    assert.deepEqual(outcome, { status: 'done', finalText: 'PARTIAL_2B_FINAL', partialText: 'PARTIAL_1_LATE_1PARTIAL_2B_FINAL' });
    assert.deepEqual(f.prompts().map(row => [row.prompt, row.pid, row.sid]),
        [['A', f.child.pid, f.protocol.nativeSessionId], ['B', f.child.pid, f.protocol.nativeSessionId]]);
    assert.equal(f.records.some(row => row.kind === 'overlap'), false);
    f.runtime.claimTurnOutcome('logical-turn');
    assert.equal(f.runtime.finalizeTurn('logical-turn', { kind: 'turn-end', status: 'done', finalText: outcome.finalText }), true);
    assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 1);
});

test('a held local cancel-write callback times out and reaps its real child without B', { timeout: 8000 }, async t => {
    const f = await fixture(t, 'missing-cancel'), { result } = await f.start();
    const original = f.child.stdin.write;
    const blocked = Promise.withResolvers<void>();
    t.mock.method(f.child.stdin, 'write', function (...args: unknown[]) {
        if (String(args[0]).includes('session/cancel')) {
            blocked.resolve();
            // Model an outstanding OS write, not a fabricated RPC cancellation result.
            return true;
        }
        return Reflect.apply(original, f.child.stdin, args);
    });
    const steering = f.runtime.steer({ text: 'B' }); void steering.catch(() => {});
    await blocked.promise; await assert.rejects(steering);
    assert.equal((await result).status, 'error'); assert.equal(f.runtime.lastError, 'acp_cancel_timeout');
    assert.equal(f.prompts().length, 1); assert.equal(f.records.some(row => row.kind === 'cancel'), false);
    await f.exited;
});

test('real idle-gap content after cancellation retires before another prompt can start', { timeout: 8000 }, async t => {
    const f = await fixture(t, 'fast');
    const owner = { binding: { runId: 'raw', sessionId: 'jaw', scope: 'scope', turnId: 'raw' },
        isCurrent: () => true, emit: () => null };
    const a = f.protocol.prompt([{ type: 'text', text: 'A' }], owner, () => {});
    await f.waitFor(row => row.kind === 'prompt');
    await f.protocol.cancel(); await a; assert.equal(f.protocol.idle, true);
    await f.command('illegal'); await f.exited;
    assert.equal(f.protocol.alive, false);
    await assert.rejects(f.protocol.prompt([{ type: 'text', text: 'B' }], owner, () => {}), /unavailable/);
    assert.equal(f.prompts().length, 1);
    // Anonymous same-session data AFTER B admission has no wire attempt identity.
    // This test certifies only the enforceable idle gap, not provider ordering after B.
});

test('Stop during held real cancellation cannot resurrect B and leaves a reusable idle session', { timeout: 8000 }, async t => {
    const f = await fixture(t), { result } = await f.start(); let commits = 0;
    const steering = f.runtime.steer({ text: 'B' }, () => { commits++; });
    await f.waitFor(row => row.kind === 'cancel');
    const stopping = f.runtime.cancel(); await f.command('release-cancel'); await stopping;
    assert.equal((await steering).accepted, false); assert.equal((await result).status, 'stopped');
    assert.equal(commits, 0); assert.equal(f.prompts().length, 1);
    assert.equal(f.protocol.idle, true); assert.equal(f.protocol.alive, true);
});
