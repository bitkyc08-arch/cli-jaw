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
for await (const line of rl) {
  const row = JSON.parse(line);
  if (row.type === 'get_state') {
    process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: 'get_state', success: true, data: { sessionId } }) + '\\n');
  } else if (row.type === 'set_thinking_level') {
    process.stdout.write(JSON.stringify({ id: row.id, type: 'response', command: row.type, success: true }) + '\\n');
  } else if (row.type === 'prompt') {
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
    process.env['PI_FAKE_ABORT_MODE'] = 'success';
    const session = spawnSession();
    const active = session.sendPrompt('LONG');
    const aborting = session.abort();
    let settled = false;
    void aborting.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'acceptance alone must not settle abort');
    await aborting;
    await active;
    session.kill();
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
