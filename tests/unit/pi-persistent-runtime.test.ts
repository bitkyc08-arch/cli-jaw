import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JAW_HOME } from '../../src/core/config.ts';
import {
    DEFAULT_PI_PROFILE,
    DEFAULT_PI_SETTINGS,
    spawnPersistentPiRpc,
    spawnPiRpc,
    type PiRpcSession,
} from '../../src/agent/pi-runtime.ts';

const fakeRoot = await mkdtemp(join(tmpdir(), 'jaw-pi-persistent-'));
const fakePi = join(fakeRoot, 'fake-pi.mjs');
const fakeSource = `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv.includes('--version')) {
  process.stdout.write('fake-pi 1.0.0\\n');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
let sessionId = 'fake-session';
let pendingAbortId = null;
for await (const line of rl) {
  const row = JSON.parse(line);
  if (row.type === 'test_release_abort') {
    process.stdout.write(JSON.stringify({ id: pendingAbortId, type: 'response', command: 'abort', success: true }) + '\\n');
    pendingAbortId = null;
  } else if (row.type === 'test_complete_prompt') {
    process.stdout.write(JSON.stringify({ type: 'agent_end', sessionId, messages: [] }) + '\\n');
  } else if (row.type === 'get_state') {
    process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: 'get_state', success: true, data: { sessionId } }) + '\\n');
  } else if (row.type === 'set_thinking_level') {
    process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: row.type, success: true }) + '\\n');
  } else if (row.type === 'prompt') {
    if (process.env.PI_FAKE_BAD_JSON === '1') process.stdout.write('{"password":"MALFORMED_PRIVATE_CANARY"\\n');
    process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: 'prompt', success: true }) + '\\n');
    if (row.message !== 'LONG') setImmediate(() => {
      process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'reply:' + row.message } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_end', sessionId, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'reply:' + row.message }] }] }) + '\\n');
    });
  } else if (row.type === 'abort') {
    if (process.env.PI_FAKE_ABORT_MODE === 'reject') {
      process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: 'abort', success: false, error: { message: 'abort denied' } }) + '\\n');
    } else if (process.env.PI_FAKE_ABORT_MODE === 'wrong-id') {
      process.stdout.write(JSON.stringify({ id: row.id + 100, type: 'response', command: 'abort', success: true }) + '\\n');
    } else if (process.env.PI_FAKE_ABORT_MODE === 'terminal-first') {
      pendingAbortId = row.id;
      process.stdout.write(JSON.stringify({ type: 'agent_end', sessionId, messages: [] }) + '\\n');
    } else if (process.env.PI_FAKE_ABORT_MODE === 'ack-first') {
      process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: 'abort', success: true }) + '\\n');
    } else if (process.env.PI_FAKE_ABORT_MODE === 'non-running') {
      process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: 'abort', success: true, data: { running: false } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: 'abort', success: true }) + '\\n');
      setTimeout(() => process.stdout.write(JSON.stringify({ type: 'agent_end', sessionId, messages: [] }) + '\\n'), 20);
    }
  }
}
`;
await writeFile(fakePi, fakeSource);
await chmod(fakePi, 0o755);

const previousBin = process.env['PI_CODING_AGENT_BIN'];
process.env['PI_CODING_AGENT_BIN'] = fakePi;
test.after(async () => {
    if (previousBin === undefined) delete process.env['PI_CODING_AGENT_BIN'];
    else process.env['PI_CODING_AGENT_BIN'] = previousBin;
    await rm(fakeRoot, { recursive: true, force: true });
});

function commandId(): string {
    return JSON.stringify({ source: 'env', command: fakePi, baseArgs: [], version: 'fake-pi 1.0.0' });
}

async function writeCapability(value: unknown): Promise<void> {
    const dir = join(JAW_HOME, 'pi');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'rpc-capabilities.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

function validCapability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schemaVersion: 1,
        abortEffective: true,
        probedAt: new Date().toISOString(),
        profileId: DEFAULT_PI_PROFILE.id,
        commandId: commandId(),
        evidence: 'unit',
        ...overrides,
    };
}

function spawnSession() {
    return spawnPersistentPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, {
        model: DEFAULT_PI_PROFILE.model,
        cwd: fakeRoot,
        root: join(fakeRoot, 'runtime'),
    });
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
}

function control(session: PiRpcSession, type: 'test_release_abort' | 'test_complete_prompt'): void {
    assert.ok(session.child.stdin);
    session.child.stdin.write(JSON.stringify({ type }) + '\n');
}

test('persistent Pi RPC isolates each prompt promise and per-turn callback', async () => {
    await writeCapability(validCapability());
    const session = spawnSession();
    const firstEvents: string[] = [];
    const first = await session.sendPrompt('FIRST', {
        onEvent: (event) => { if (event.kind === 'text') firstEvents.push(event.text); },
    });
    const secondEvents: string[] = [];
    const second = await session.sendPrompt('SECOND', {
        onEvent: (event) => { if (event.kind === 'text') secondEvents.push(event.text); },
    });
    assert.equal(first.text, 'reply:FIRST');
    assert.equal(second.text, 'reply:SECOND');
    assert.deepEqual(firstEvents, ['reply:FIRST']);
    assert.deepEqual(secondEvents, ['reply:SECOND']);
    session.kill();
});

test('persistent Pi RPC rejects overlapping prompts', async () => {
    const session = spawnSession();
    const active = session.sendPrompt('LONG');
    await assert.rejects(session.sendPrompt('SECOND'), /prompt already active/);
    session.kill();
    await assert.rejects(active, /session exited/);
});

test('abort requires correlated acceptance and terminal completion', async () => {
    const previousMode = process.env['PI_FAKE_ABORT_MODE'];
    process.env['PI_FAKE_ABORT_MODE'] = 'ack-first';
    const session = spawnSession();
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
    const active = session.sendPrompt('LONG', { onRawRecord: raw => {
        if (asRecord(raw)['command'] === 'abort') acknowledge();
    } });
    const aborting = session.abort();
    let settled = false;
    void aborting.then(() => { settled = true; }, () => {});
    try {
        await acknowledged;
        assert.equal(settled, false, 'observed correlated acceptance alone must not settle abort');
        control(session, 'test_complete_prompt');
        await aborting;
        await active;
    } finally {
        session.kill();
        await Promise.allSettled([active, aborting]);
        if (previousMode === undefined) delete process.env['PI_FAKE_ABORT_MODE'];
        else process.env['PI_FAKE_ABORT_MODE'] = previousMode;
    }
});

test('abort rejection propagates so the pool caller can fall back to kill', async () => {
    process.env['PI_FAKE_ABORT_MODE'] = 'reject';
    const session = spawnSession();
    const active = session.sendPrompt('LONG');
    await assert.rejects(session.abort(), /abort denied/);
    session.kill();
    await assert.rejects(active, /session exited/);
    delete process.env['PI_FAKE_ABORT_MODE'];
});

test('abort ignores an uncorrelated success response', async () => {
    process.env['PI_FAKE_ABORT_MODE'] = 'wrong-id';
    const session = spawnSession();
    const active = session.sendPrompt('LONG');
    const aborting = session.abort();
    let settled = false;
    void aborting.then(() => { settled = true; }, () => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    session.kill();
    await assert.rejects(aborting, /session exited/);
    await assert.rejects(active, /session exited/);
});

test('abort accepts a correlated success with an explicit non-running state', async () => {
    process.env['PI_FAKE_ABORT_MODE'] = 'non-running';
    const session = spawnSession();
    const active = session.sendPrompt('LONG');
    await session.abort();
    await active;
    session.kill();
    delete process.env['PI_FAKE_ABORT_MODE'];
});

for (const fixture of [
    { name: 'missing', prepare: () => rm(join(JAW_HOME, 'pi', 'rpc-capabilities.json'), { force: true }) },
    { name: 'corrupt', prepare: () => writeCapability('{bad json') },
    { name: 'schema mismatch', prepare: () => writeCapability(validCapability({ schemaVersion: 2 })) },
    { name: 'profile mismatch', prepare: () => writeCapability(validCapability({ profileId: 'other' })) },
    { name: 'command mismatch', prepare: () => writeCapability(validCapability({ commandId: 'other' })) },
    { name: 'expired', prepare: () => writeCapability(validCapability({ probedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString() })) },
] as const) {
    test(`abortEffective is false for ${fixture.name} capability evidence`, async () => {
        await fixture.prepare();
        const session = spawnSession();
        assert.equal(session.abortEffective, false);
        session.kill();
    });
}

test('abortEffective is true only for fresh matching capability evidence', async () => {
    await writeCapability(validCapability());
    const session = spawnSession();
    assert.equal(session.abortEffective, true);
    session.kill();
});

test('raw records precede accepted events and stay with their prompt even when the observer throws', async t => {
    const warnings: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const session = spawnSession();
    const order: string[] = [];
    const firstRaw: string[] = [];
    const secondRaw: string[] = [];
    const secondText: string[] = [];
    try {
        const first = await session.sendPrompt('FIRST', {
            onRawRecord: raw => {
                const type = String(asRecord(raw)['type']);
                firstRaw.push(type);
                order.push('raw:' + type);
            },
            onEvent: event => { order.push('event:' + event.kind); },
        });
        const firstCount = firstRaw.length;
        const second = await session.sendPrompt('SECOND', {
            onRawRecord: raw => {
                secondRaw.push(String(asRecord(raw)['type']));
                throw new Error('observer-secret-canary');
            },
            onEvent: event => { if (event.kind === 'text') secondText.push(event.text); },
        });
        assert.equal(first.text, 'reply:FIRST');
        assert.equal(second.text, 'reply:SECOND');
        assert.deepEqual(secondText, ['reply:SECOND']);
        assert.equal(firstRaw.length, firstCount, 'a later prompt must not retain the earlier raw observer');
        assert.ok(firstRaw.includes('agent_end') && secondRaw.includes('agent_end'));
        assert.ok(order.indexOf('raw:message_update') >= 0);
        assert.ok(order.indexOf('raw:message_update') < order.indexOf('event:text'));
        assert.equal(order.filter(entry => entry === 'event:text').length, 1, 'agent_end echo remains suppressed');
        assert.equal(warnings.length, secondRaw.length);
        assert.ok(warnings.every(args => args.length === 1 && args[0] === '[jaw:pi] raw activity observer failed'));
    } finally { session.kill(); }
});

for (const scenario of [
    { newerPrompt: false, observeOld: true },
    { newerPrompt: true, observeOld: true },
    { newerPrompt: true, observeOld: false },
]) {
    test('terminal-before-ACK retains abort observer ownership: ' + JSON.stringify(scenario), async t => {
        t.mock.method(console, 'warn', () => {});
        const previousMode = process.env['PI_FAKE_ABORT_MODE'];
        process.env['PI_FAKE_ABORT_MODE'] = 'terminal-first';
        const session = spawnSession();
        const firstRaw: Array<Record<string, unknown>> = [];
        const newerRaw: Array<Record<string, unknown>> = [];
        const first = session.sendPrompt('LONG', scenario.observeOld ? { onRawRecord: raw => {
            const record = asRecord(raw);
            firstRaw.push(record);
            if (scenario.newerPrompt && record['command'] === 'abort') throw new Error('abort observer failure');
        } } : {});
        const aborting = session.abort();
        let abortSettled = false;
        void aborting.then(() => { abortSettled = true; }, () => {});
        let newer: ReturnType<PiRpcSession['sendPrompt']> | undefined;
        let newerSettled = false;
        try {
            await first;
            assert.equal(abortSettled, false, 'terminal alone cannot settle the abort waiter');
            if (scenario.newerPrompt) {
                newer = session.sendPrompt('LONG', { onRawRecord: raw => { newerRaw.push(asRecord(raw)); } });
                void newer.then(() => { newerSettled = true; }, () => {});
            }
            control(session, 'test_release_abort');
            await aborting;
            assert.equal(firstRaw.filter(record => record['command'] === 'abort').length, scenario.observeOld ? 1 : 0);
            assert.equal(newerRaw.filter(record => record['command'] === 'abort').length, 0,
                'absence of an old observer must not fall back to the new prompt observer');
            if (scenario.observeOld) assert.ok(firstRaw.some(record => record['type'] === 'agent_end'));
            if (newer) {
                assert.equal(newerSettled, false, 'the old abort ACK cannot finish the new prompt');
                assert.ok(newerRaw.some(record => record['command'] === 'prompt'));
                const firstCount = firstRaw.length;
                control(session, 'test_complete_prompt');
                await newer;
                assert.equal(firstRaw.length, firstCount, 'settled abort observer is no longer retained');
                assert.ok(newerRaw.some(record => record['type'] === 'agent_end'));
            }
        } finally {
            session.kill();
            await Promise.allSettled([first, aborting, ...(newer ? [newer] : [])]);
            if (previousMode === undefined) delete process.env['PI_FAKE_ABORT_MODE'];
            else process.env['PI_FAKE_ABORT_MODE'] = previousMode;
        }
    });
}

test('new active prompt without raw observer cannot fall back to the previous abort observer', async () => {
    const previousMode = process.env['PI_FAKE_ABORT_MODE'];
    process.env['PI_FAKE_ABORT_MODE'] = 'terminal-first';
    const session = spawnSession();
    const oldRecords: Array<Record<string, unknown>> = [];
    const first = session.sendPrompt('LONG', { onRawRecord: raw => { oldRecords.push(asRecord(raw)); } });
    const aborting = session.abort();
    let newer: ReturnType<PiRpcSession['sendPrompt']> | undefined;
    try {
        await first;
        const beforeNewPrompt = oldRecords.length;
        newer = session.sendPrompt('LONG'); // Deliberately no raw observer.
        // The fake processes stdin in order: new prompt response, then old ACK.
        control(session, 'test_release_abort');
        await aborting;
        assert.deepEqual(oldRecords.slice(beforeNewPrompt).map(record => record['command']), ['abort'],
            'only the correlated old ACK belongs to the old observer, not the new prompt response');
        const afterAbort = oldRecords.length;
        control(session, 'test_complete_prompt');
        assert.equal((await newer).text, '');
        assert.equal(oldRecords.length, afterAbort);
    } finally {
        session.kill();
        await Promise.allSettled([first, aborting, ...(newer ? [newer] : [])]);
        if (previousMode === undefined) delete process.env['PI_FAKE_ABORT_MODE'];
        else process.env['PI_FAKE_ABORT_MODE'] = previousMode;
    }
});

for (const throws of [false, true]) {
    test('one-shot raw ordering and final echo compatibility, observer throws=' + throws, async t => {
        t.mock.method(console, 'warn', () => {});
        const order: string[] = [];
        const { child, done } = spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, {
            prompt: 'EMPLOYEE', model: DEFAULT_PI_PROFILE.model, cwd: fakeRoot,
            root: join(fakeRoot, 'employee-runtime'),
            onRawRecord: raw => {
                order.push('raw:' + String(asRecord(raw)['type']));
                if (throws) throw new Error('one-shot observer failure');
            },
            onEvent: event => { order.push('event:' + event.kind); },
        });
        try {
            const result = await done;
            assert.equal(result.code, 0);
            assert.equal(result.text, 'reply:EMPLOYEE');
            assert.equal(result.sessionId, 'fake-session');
            assert.equal(order.filter(entry => entry === 'event:text').length, 1);
            assert.ok(order.indexOf('raw:message_update') >= 0);
            assert.ok(order.indexOf('raw:message_update') < order.indexOf('event:text'));
            assert.ok(order.includes('raw:agent_end'));
        } finally { child.kill(); }
    });
}

for (const oneShot of [false, true]) {
    test('malformed Pi frame diagnostics omit private payload, one-shot=' + oneShot, async t => {
        const old = process.env['PI_FAKE_BAD_JSON'];
        process.env['PI_FAKE_BAD_JSON'] = '1';
        const warnings: string[] = [];
        t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
        let cleanup = () => {};
        try {
            if (oneShot) {
                const run = spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, {
                    prompt: 'SAFE', model: DEFAULT_PI_PROFILE.model, cwd: fakeRoot,
                    root: join(fakeRoot, 'malformed-one-shot'),
                });
                cleanup = () => { run.child.kill(); };
                assert.equal((await run.done).text, 'reply:SAFE');
            } else {
                const session = spawnSession();
                cleanup = () => { session.kill(); };
                assert.equal((await session.sendPrompt('SAFE')).text, 'reply:SAFE');
            }
            assert.ok(warnings.some(message => message.includes('JSON parse failed')));
            assert.ok(warnings.every(message => !message.includes('MALFORMED_PRIVATE_CANARY')));
        } finally {
            cleanup();
            if (old === undefined) delete process.env['PI_FAKE_BAD_JSON'];
            else process.env['PI_FAKE_BAD_JSON'] = old;
        }
    });
}
