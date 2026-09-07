import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSdkOwners } from '../../src/agent/runtime/claude-sdk-owners.ts';
function owner(id = 'turn') {
    return { context: { runId: 'r', sessionId: 'j', scope: 's', turnId: id, audience: 'internal' as const }, isCurrent: () => true, emit() {} };
}
test('callback wait resolves only to its exact subsequently observed tool owner', async () => {
    const owners = new ClaudeSdkOwners(), first = owner(), second = owner('other');
    const pending = owners.resolve('wanted');
    owners.bind('other', second); owners.bind('wanted', first);
    assert.equal(await pending, first); owners.close();
});
test('retirement releases captured owner and prevents reuse for another borrower', async () => {
    const owners = new ClaudeSdkOwners(), old = owner();
    owners.bind('tool', old); owners.retire(old.context);
    assert.equal(await owners.resolve('tool'), null);
    assert.throws(() => owners.bind('tool', owner('new')), /retired/); owners.close();
});
test('unknown callbacks are bounded and cancellation resolves all waiters', async () => {
    const owners = new ClaudeSdkOwners();
    const pending = Array.from({ length: 32 }, () => owners.resolve('same'));
    assert.equal(await owners.resolve('overflow'), null);
    owners.cancelPending(); assert.deepEqual(await Promise.all(pending), Array(32).fill(null)); owners.close();
});
test('unknown callback expires within the one-second frame ordering window', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owners = new ClaudeSdkOwners(); const pending = owners.resolve('missing');
    t.mock.timers.tick(1000); assert.equal(await pending, null); owners.close();
});
test('513th retirement cannot evict an old identity and bind it to a new borrower', async () => {
    const owners = new ClaudeSdkOwners();
    for (let i = 0; i < 512; i++) { const captured = owner(String(i)); owners.bind(`tool-${i}`, captured); owners.retire(captured.context); }
    assert.equal(owners.saturated, true);
    assert.throws(() => owners.bind('tool-512', owner('new')), /capacity/);
    assert.throws(() => owners.bind('tool-0', owner('new')), /capacity|retired/);
    assert.equal(await owners.resolve('tool-0'), null); owners.close();
});
