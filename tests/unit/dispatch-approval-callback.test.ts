// M4-A2a: opaque approval callbacks. Native UI is not wired yet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DispatchApprovalStore, dispatchApprovalStore } from '../../src/core/dispatch-approval.ts';
import { createTestTransport, handleApprovalCallback, handleApprovalCommand } from '../../src/core/dispatch-approval-ingress.ts';
import { settings } from '../../src/core/config.ts';

function store(now = { t: 1_700_000_000_000 }) {
    return new DispatchApprovalStore(() => now.t, 'boot-gen');
}

function pending(s: DispatchApprovalStore) {
    return s.create({ target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 't', mutable: false, scope: null, fanOutCap: 1 });
}

const presented = {
    actorId: 'U1',
    conversationKey: 'conv:1',
    sessionGeneration: 3,
    action: 'approve' as const,
};

test('opaque id does not embed jti or digest', () => {
    const s = store();
    const row = pending(s);
    const id = s.issueApprovalCallback(row.jti, presented);
    assert.ok(id);
    assert.notEqual(id, row.jti);
    assert.ok(!id!.includes(row.digest));
    assert.ok(!id!.includes(row.jti));
});

test('matching callback consumes once', () => {
    const s = store();
    const row = pending(s);
    const id = s.issueApprovalCallback(row.jti, presented)!;
    const ok = s.resolveApprovalCallback(id, presented);
    assert.equal(ok.ok, true);
    const consumed = s.consume({ jti: row.jti, digest: row.digest, platform: 'telegram', senderId: 'U1' });
    assert.equal(consumed.ok, true);
    const again = s.consume({ jti: row.jti, digest: row.digest, platform: 'telegram', senderId: 'U1' });
    assert.equal(again.ok, false);
});

test('mismatch classes refuse without consuming', () => {
    const s = store();
    const row = pending(s);
    const id = s.issueApprovalCallback(row.jti, presented)!;
    assert.equal(s.resolveApprovalCallback('nope', presented).ok, false);
    assert.equal(s.resolveApprovalCallback(id, { ...presented, actorId: 'U2' }).ok === false && s.resolveApprovalCallback(id, { ...presented, actorId: 'U2' }).reason, 'actor_mismatch');
    assert.equal(s.resolveApprovalCallback(id, { ...presented, conversationKey: 'other' }).reason, 'conversation_mismatch');
    assert.equal(s.resolveApprovalCallback(id, { ...presented, sessionGeneration: 9 }).reason, 'generation_mismatch');
    assert.equal(s.resolveApprovalCallback(id, { ...presented, action: 'deny' }).reason, 'action_mismatch');
    assert.equal(s.get(row.jti)?.status, 'pending');
});

test('expired callback refuses', () => {
    const now = { t: 1_700_000_000_000 };
    const s = store(now);
    const row = pending(s);
    const id = s.issueApprovalCallback(row.jti, presented)!;
    now.t = row.expiresAt + 1;
    const refused = s.resolveApprovalCallback(id, presented);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.reason, 'expired');
});

test('a new store instance cannot resolve an old opaque id', () => {
    const a = store();
    const row = pending(a);
    const id = a.issueApprovalCallback(row.jti, presented)!;
    const b = store();
    assert.equal(b.resolveApprovalCallback(id, presented).reason, 'not_found');
});

test('ingress callback uses digest from the binding, not the wire', () => {
    settings.dispatchApproval = { operators: { telegram: ['42'], slack: [], discord: [] }, ttlSeconds: 120 };
    const row = dispatchApprovalStore.create({ target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 't', mutable: false, scope: null, fanOutCap: 1 });
    const id = dispatchApprovalStore.issueApprovalCallback(row.jti, {
        actorId: '42', conversationKey: 'tg:1', sessionGeneration: 0, action: 'approve',
    })!;
    const transport = createTestTransport('telegram');
    const result = handleApprovalCallback(
        transport,
        { message: { from: { id: 42, is_bot: false } } },
        id,
        'approve',
        { conversationKey: 'tg:1', sessionGeneration: 0 },
    );
    assert.equal(result.approved, true);
    assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'approved');
    // text path still requires digest
    const row2 = dispatchApprovalStore.create({ target: { kind: 'agent', name: 'B' }, projectRoot: '/r', task: 't2', mutable: false, scope: null, fanOutCap: 1 });
    assert.equal(handleApprovalCommand(transport, { message: { from: { id: 42 } } }, `approve ${row2.jti}`).handled, false);
});

test('approve and deny race on one jti is a single terminal', () => {
    const s = store();
    const row = pending(s);
    const approveId = s.issueApprovalCallback(row.jti, presented)!;
    const denyId = s.issueApprovalCallback(row.jti, { ...presented, action: 'deny' })!;
    const first = s.resolveApprovalCallback(approveId, presented);
    assert.equal(first.ok, true);
    s.consume({ jti: row.jti, digest: row.digest, platform: 'slack', senderId: 'U1' });
    const deny = s.resolveApprovalCallback(denyId, { ...presented, action: 'deny' });
    assert.equal(deny.ok, true); // binding still matches
    assert.equal(s.cancel(row.jti, row.digest), false); // already approved
    assert.equal(s.get(row.jti)?.status, 'approved');
});

test('interactive slack user object is an operator id, not [object Object]', () => {
    settings.dispatchApproval = { operators: { slack: ['U1'], telegram: [], discord: [] }, ttlSeconds: 120 };
    const row = dispatchApprovalStore.create({ target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 'slack-obj', mutable: false, scope: null, fanOutCap: 1 });
    const id = dispatchApprovalStore.issueApprovalCallback(row.jti, {
        actorId: 'U1', conversationKey: 'U1', sessionGeneration: 0, action: 'approve',
    })!;
    const transport = createTestTransport('slack');
    const result = handleApprovalCallback(
        transport,
        { user: { id: 'U1' } },
        id,
        'approve',
        { conversationKey: 'U1', sessionGeneration: 0 },
    );
    assert.equal(result.approved, true, result.reason);
});
