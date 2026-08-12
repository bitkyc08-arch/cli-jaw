import test from 'node:test';
import assert from 'node:assert/strict';
import { DispatchApprovalStore, formatDispatchApprovalMessage } from '../../src/core/dispatch-approval.js';

function make(store: DispatchApprovalStore, extra: Record<string, unknown> = {}) {
    return store.create({
        target: { kind: 'agent', name: 'Backend' }, projectRoot: '/repo', task: 'secret task body',
        mutable: true, scope: 'src', fanOutCap: 1, ...extra,
    });
}

test('pending approval is canonical, single-use, and rejects duplicate JTI consumption', () => {
    const store = new DispatchApprovalStore(() => 1_000, 'boot-a');
    const row = make(store);
    assert.equal(row.taskDigest.length, 64);
    assert.equal(row.digest.length, 64);
    assert.doesNotMatch(formatDispatchApprovalMessage(row), /secret task body/);
    assert.equal(store.consume({ jti: row.jti, digest: row.digest, platform: 'slack', senderId: 'U1' }).ok, true);
    assert.deepEqual(store.consume({ jti: row.jti, digest: row.digest, platform: 'slack', senderId: 'U1' }), { ok: false, reason: 'approved' });
});

test('expiry and cancellation are terminal', () => {
    let now = 0;
    const store = new DispatchApprovalStore(() => now, 'boot-a');
    const expired = make(store, { ttlSeconds: 1 });
    now = 1_000;
    assert.equal(store.consume({ jti: expired.jti, digest: expired.digest, platform: 'telegram', senderId: '1' }).ok, false);
    const cancelled = make(store);
    assert.equal(store.cancel(cancelled.jti, cancelled.digest), true);
    assert.deepEqual(store.consume({ jti: cancelled.jti, digest: cancelled.digest, platform: 'discord', senderId: '1' }), { ok: false, reason: 'cancelled' });
});

test('modified digest and cross-instance audience are rejected', () => {
    const store = new DispatchApprovalStore(() => 0, 'boot-a');
    const row = make(store);
    assert.deepEqual(store.consume({ jti: row.jti, digest: '0'.repeat(64), platform: 'slack', senderId: 'U1' }), { ok: false, reason: 'digest_mismatch' });
    assert.deepEqual(store.consume({ jti: row.jti, digest: row.digest, audience: 'cli-jaw:boot-b', platform: 'slack', senderId: 'U1' }), { ok: false, reason: 'audience_mismatch' });
});

test('concurrent approval race has one winner', async () => {
    const store = new DispatchApprovalStore(() => 0, 'boot-a');
    const row = make(store);
    const results = await Promise.all(Array.from({ length: 8 }, async () => store.consume({ jti: row.jti, digest: row.digest, platform: 'slack', senderId: 'U1' })));
    assert.equal(results.filter(result => result.ok).length, 1);
});

test('employee marker is refused and restart generation cannot see old pending state', () => {
    const firstBoot = new DispatchApprovalStore(() => 0, 'boot-a');
    const row = make(firstBoot);
    assert.throws(() => make(firstBoot, { employeeMarker: true }), /employee_dispatch_approval_forbidden/);
    const restarted = new DispatchApprovalStore(() => 0, 'boot-b');
    assert.equal(restarted.get(row.jti), null);
});

test('fake-channel out-of-band consume remains scoped to exact displayed digest', async () => {
    let ran = false;
    const store = new DispatchApprovalStore(() => 0, 'boot-a');
    const row = make(store, { onApproved: async () => { ran = true; return { ok: true }; } });
    assert.equal(store.consume({ jti: row.jti, digest: row.digest, platform: 'discord', senderId: 'fake-channel-user' }).ok, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ran, true);
    assert.equal(store.get(row.jti)?.status, 'completed');
});
