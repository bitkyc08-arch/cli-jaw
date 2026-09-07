import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawnPiRpc, spawnPersistentPiRpc, DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, type PiRuntimeEvent } from '../../src/agent/pi-runtime.ts';
import { piFailureOutcome } from '../../src/agent/runtime/pi-turn.ts';

const root = mkdtempSync(join(tmpdir(), 'pi-observer-'));
const binary = join(root, 'pi.mjs');
copyFileSync(new URL('../fixtures/pi-semantic-child.mjs', import.meta.url), binary);
chmodSync(binary, 0o755);
const previous = process.env.PI_CODING_AGENT_BIN;
process.env.PI_CODING_AGENT_BIN = binary;
test.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_BIN; else process.env.PI_CODING_AGENT_BIN = previous;
    rmSync(root, { recursive: true, force: true });
});
const opts = { model: 'fixture', cwd: root, root };
async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('fixture operation deadline')), 2000); });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer!); }
}
function cleanup(child: ChildProcess) {
    const closed = once(child, 'close');
    return async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await bounded(closed);
    };
}

for (const kind of ['session', 'tool', 'thinking', 'text'] as const) {
    for (const mode of ['direct', 'persistent'] as const) {
        test(`${mode} throwing ${kind} semantic observer cannot strand settlement or leak payload`, { timeout: 7000 }, async t => {
            const warnings: string[] = [], seen: string[] = [];
            let throws = 0;
            t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
            t.mock.method(globalThis, 'fetch', async () => { throw Error('network forbidden'); });
            const onEvent = (event: PiRuntimeEvent) => {
                seen.push(event.kind);
                if (event.kind === kind) { throws++; throw Error('PRIVATE_OBSERVER_CANARY'); }
            };
            if (mode === 'direct') {
                const run = spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, { ...opts, prompt: 'FIRST', onEvent });
                const close = cleanup(run.child);
                try {
                    const result = await bounded(run.done);
                    assert.equal(result.code, 0);
                    assert.deepEqual(result.runtimeOutcome, { status: 'done', finalText: 'FIRST', partialText: 'FIRST' });
                } finally { await close(); }
            } else {
                const session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, opts);
                const close = cleanup(session.child);
                try {
                    const first = await bounded(session.sendPrompt('FIRST', { onEvent }));
                    assert.deepEqual(first.runtimeOutcome, { status: 'done', finalText: 'FIRST', partialText: 'FIRST' });
                    const before = seen.length, next: string[] = [];
                    const second = await bounded(session.sendPrompt('SECOND', { onEvent: e => { next.push(e.kind); } }));
                    assert.deepEqual(second.runtimeOutcome, { status: 'done', finalText: 'SECOND', partialText: 'SECOND' });
                    assert.equal(seen.length, before, 'old callback cannot receive next prompt events');
                    assert.ok(next.includes('text')); assert.equal(session.alive, true);
                } finally { await close(); }
            }
            assert.ok(throws > 0); assert.ok(seen.includes('text'), 'later semantic records still execute');
            assert.equal(warnings.length, throws);
            assert.ok(warnings.every(warning => warning === '[jaw:pi] semantic observer failed'));
            assert.ok(!warnings.join('').includes('PRIVATE_OBSERVER_CANARY'));
        });
    }
}

test('foreign failed prompt IDs do not settle either adapter; direct post-terminal records and clean EOF cannot rewrite success', { timeout: 7000 }, async () => {
    for (const prompt of ['FOREIGN_REJECTION', 'LATE']) {
        const accepted: string[] = [];
        const run = spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, { ...opts, prompt,
            onEvent: event => { if (event.kind === 'text') accepted.push(event.text); } });
        const close = cleanup(run.child);
        try {
            const result = await bounded(run.done);
            assert.equal(result.code, 0);
            assert.deepEqual(result.runtimeOutcome, { status: 'done', finalText: prompt, partialText: prompt });
            await close();
            assert.deepEqual(accepted, [prompt]);
        } finally { await close(); }
    }
    const session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, opts);
    const close = cleanup(session.child);
    try {
        assert.equal((await bounded(session.sendPrompt('FOREIGN_REJECTION'))).runtimeOutcome?.finalText, 'FOREIGN_REJECTION');
    } finally { await close(); }
});

test('clean direct EOF without terminal is error with null final, while correlated rejection returns code one', { timeout: 7000 }, async () => {
    for (const prompt of ['EOF', 'EOF_BEFORE_SETTLED', 'OWN_REJECTION']) {
        const run = spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, { ...opts, prompt });
        const close = cleanup(run.child);
        try {
            const result = await bounded(run.done);
            assert.equal(result.code, prompt === 'OWN_REJECTION' ? 1 : 0, 'process code and semantic outcome are distinct');
            assert.deepEqual(result.runtimeOutcome, { status: 'error', finalText: null, partialText: prompt });
        } finally { await close(); }
    }
});

test('persistent owned rejection carries only its partial and allows next distinct prompt', { timeout: 7000 }, async () => {
    const session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, opts);
    const close = cleanup(session.child);
    try {
        await assert.rejects(bounded(session.sendPrompt('OWN_REJECTION')), error => {
            assert.deepEqual(piFailureOutcome(error), { status: 'error', finalText: null, partialText: 'OWN_REJECTION' }); return true;
        });
        assert.deepEqual((await bounded(session.sendPrompt('SECOND'))).runtimeOutcome, { status: 'done', finalText: 'SECOND', partialText: 'SECOND' });
    } finally { await close(); }
});

test('foreign non-running responses cannot finish abort; terminal-before-ACK cannot stop the next borrower', { timeout: 7000 }, async () => {
    const session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, opts);
    const close = cleanup(session.child);
    const ready = Promise.withResolvers<void>(), foreign = Promise.withResolvers<void>();
    const raw = (row: unknown) => {
        const type = (row as { type?: string }).type;
        if (type === 'fixture_ready') ready.resolve();
        if (type === 'fixture_foreign_abort') foreign.resolve();
    };
    const write = (type: string) => session.child.stdin!.write(JSON.stringify({ type }) + '\n');
    let promptDone = false, abortDone = false;
    const first = session.sendPrompt('HOLD', { onRawRecord: raw });
    void first.then(() => { promptDone = true; }, () => {});
    try {
        await bounded(ready.promise);
        const abort = session.abort(); void abort.then(() => { abortDone = true; }, () => {});
        await bounded(foreign.promise); await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(promptDone, false); assert.equal(abortDone, false);
        write('test_terminal');
        assert.deepEqual((await bounded(first)).runtimeOutcome, { status: 'stopped', finalText: null, partialText: 'HOLD' });
        assert.equal(abortDone, false);
        const nextReady = Promise.withResolvers<void>();
        const next = session.sendPrompt('HOLD', { onRawRecord: row => {
            if ((row as { type?: string }).type === 'fixture_ready') nextReady.resolve();
        } });
        let nextDone = false; void next.then(() => { nextDone = true; }, () => {});
        await bounded(nextReady.promise); write('test_ack'); await bounded(abort);
        assert.equal(nextDone, false, 'old accepted non-running ACK cannot settle the newer prompt');
        write('test_terminal'); await bounded(next);
    } finally { await close(); }
});
