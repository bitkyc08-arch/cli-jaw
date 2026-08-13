// M4-A1: the six remote session commands are visible on all three channels.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleCommands } from '../../src/command-contract/policy.ts';
import { COMMANDS } from '../../src/cli/commands.ts';
import { handleApprovalCommand, createTestTransport } from '../../src/core/dispatch-approval-ingress.ts';

const SIX = ['new', 'stop', 'status', 'queue', 'approve', 'deny'] as const;

for (const iface of ['telegram', 'discord', 'slack'] as const) {
    test(`six session commands are visible on ${iface}`, () => {
        const names = new Set(getVisibleCommands(iface).map(c => c.name));
        for (const name of SIX) {
            assert.ok(names.has(name), `${name} missing on ${iface}`);
        }
    });
}

test('stop is not a process-wide quit', () => {
    const stop = COMMANDS.find(c => c.name === 'stop');
    const quit = COMMANDS.find(c => c.name === 'quit');
    assert.ok(stop);
    assert.ok(quit);
    assert.notEqual(stop!.handler, quit!.handler);
    assert.ok(!stop!.interfaces.includes('cli'));
});

test('approve/deny text without digest is not handled', () => {
    const transport = createTestTransport('telegram');
    assert.equal(handleApprovalCommand(transport, { message: { from: { id: 1 } } }, 'approve').handled, false);
    assert.equal(handleApprovalCommand(transport, { message: { from: { id: 1 } } }, 'deny').handled, false);
});

test('deny aliases cancel on the existing store', async () => {
    const { dispatchApprovalStore } = await import('../../src/core/dispatch-approval.ts');
    const { settings } = await import('../../src/core/config.ts');
    settings.dispatchApproval = { operators: { telegram: ['42'] } } as typeof settings.dispatchApproval;
    const created = dispatchApprovalStore.create({
        target: { kind: 'agent', name: 'x' },
        projectRoot: '/tmp',
        task: 't',
        mutable: false,
        scope: null,
        fanOutCap: 1,
    });
    const transport = createTestTransport('telegram');
    const event = { message: { from: { id: 42 } } };
    const denied = handleApprovalCommand(transport, event, `deny ${created.jti} ${created.digest}`);
    assert.equal(denied.handled, true);
    assert.equal(denied.approved, false);
    assert.equal(denied.reason, 'cancelled');
});
