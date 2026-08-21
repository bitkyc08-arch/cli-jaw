// Cycle 10 (parity2 100): cross-process active-command store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    registerActiveCommand,
    releaseActiveCommand,
    heartbeatActiveCommand,
    listActiveCommands,
    activeCommandTargetIds,
    withActiveCommand,
    ActiveCommandTargetOwnedError,
} from '../../src/browser/web-ai/active-command-store.ts';

test('AC-1: register/list/release lifecycle', async () => {
    const cmd = await registerActiveCommand({ command: 'poll', owner: 'test', targetId: 'T-ac-1', ttlMs: 60_000 });
    assert.equal(cmd.status, 'running');
    const active = await listActiveCommands({ active: true, targetId: 'T-ac-1' });
    assert.equal(active.length, 1);
    const ids = await activeCommandTargetIds();
    assert.ok(ids.has('T-ac-1'));
    await releaseActiveCommand(cmd.commandId);
    const after = await listActiveCommands({ active: true, targetId: 'T-ac-1' });
    assert.equal(after.length, 0);
});

test('AC-2: target conflict rejects a second running command on the same tab', async () => {
    const first = await registerActiveCommand({ command: 'send', targetId: 'T-ac-2', ttlMs: 60_000 });
    await assert.rejects(
        registerActiveCommand({ command: 'poll', targetId: 'T-ac-2', ttlMs: 60_000 }),
        (err: unknown) => err instanceof ActiveCommandTargetOwnedError,
    );
    await releaseActiveCommand(first.commandId);
});

test('AC-3: expired commands stop protecting their tabs', async () => {
    const cmd = await registerActiveCommand({ command: 'poll', targetId: 'T-ac-3', ttlMs: 1 });
    await new Promise(r => setTimeout(r, 10));
    const ids = await activeCommandTargetIds();
    assert.equal(ids.has('T-ac-3'), false, 'expired command no longer protects the tab');
    await releaseActiveCommand(cmd.commandId).catch(() => undefined);
});

test('AC-4: withActiveCommand always releases, heartbeat extends', async () => {
    let seen: string | null = null;
    await withActiveCommand({ command: 'wrapped', targetId: 'T-ac-4', ttlMs: 60_000, heartbeatIntervalMs: 0 }, async (cmd) => {
        seen = cmd.commandId;
        const hb = await heartbeatActiveCommand(cmd.commandId, { ttlMs: 120_000 });
        assert.ok(hb);
    });
    assert.ok(seen);
    const after = await listActiveCommands({ active: true, targetId: 'T-ac-4' });
    assert.equal(after.length, 0);
    await assert.rejects(
        withActiveCommand({ command: 'failing', targetId: 'T-ac-4b', heartbeatIntervalMs: 0 }, async () => { throw new Error('boom'); }),
        /boom/,
    );
    const failed = await listActiveCommands({ targetId: 'T-ac-4b' });
    assert.equal(failed[0]?.status, 'failed');
});

