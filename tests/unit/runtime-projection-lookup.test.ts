import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeProjection } from '../../src/agent/runtime/projection.ts';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';
function fixture() {
    const events: RuntimeEvent[] = []; let failing = false;
    const projection = new RuntimeProjection({ runId: 'run', sessionId: 'chat', scope: 's', turnId: 't', audience: 'internal' },
        (ctx, body) => { if (failing) return null; const event = { ...ctx, version: 1 as const, seq: events.length + 1, ...body }; events.push(event); return event; }, () => {});
    return { projection, events, fail: () => { failing = true; } };
}
test('lookup never allocates or emits and returns actual published terminal tool identity', () => {
    const f = fixture();
    assert.equal(f.projection.itemId('tool', 'native-private'), null);
    assert.equal(f.projection.diagnostics().items, 0); assert.equal(f.events.length, 0);
    f.projection.tool('native-private', { name: 'Read', status: 'done', output: 'ok' });
    const event = f.events[0]!; assert.equal(event.kind, 'tool');
    assert.equal(f.projection.itemId('tool', 'native-private'), event.itemId);
    assert.equal(event.itemId, 'item-1'); assert.equal(f.events.length, 1);
    assert.ok(!JSON.stringify(f.events).includes('native-private'));
    assert.equal(f.projection.itemId('message', 'native-private'), null);
});
test('recording failure makes previous display mapping unavailable without new events', () => {
    const f = fixture(); f.projection.tool('a', { status: 'running' });
    assert.ok(f.projection.itemId('tool', 'a'));
    f.fail(); f.projection.text('message', 'b', 'lost', 'replace');
    const count = f.events.length;
    assert.equal(f.projection.itemId('tool', 'a'), null); assert.equal(f.projection.itemId('message', 'b'), null);
    assert.equal(f.events.length, count);
});
test('capacity-rejected item never gains a fabricated lookup identity', () => {
    const f = fixture();
    for (let i = 0; i < 160; i++) f.projection.tool(`id-${i}`, { status: 'done' });
    const count = f.events.length;
    f.projection.tool('overflow', { status: 'running' });
    assert.equal(f.projection.itemId('tool', 'overflow'), null); assert.equal(f.events.length, count);
});
