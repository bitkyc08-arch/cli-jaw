import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';

// Pure lookup tests inject their recorder; reaching a default writer is a bug.
let defaultWrites = 0;
mock.module('../../src/trace/activity-journal.js', { namedExports: {
    markActivityFailure: () => {},
    appendActivityBody: () => { defaultWrites++; throw new Error('Unexpected default journal write'); },
} });
test.after(() => assert.equal(defaultWrites, 0));
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');

function fixture() {
    const events: RuntimeEvent[] = [];
    let failing = false;
    const projection = new RuntimeProjection({ runId: 'run', sessionId: 'chat',
        scope: 'scope', turnId: 'turn', audience: 'internal' }, (context, body) => {
        if (failing) return null;
        const event: RuntimeEvent = { ...context, version: 1, seq: events.length + 1, ...body };
        events.push(event); return event;
    }, () => {});
    return { projection, events, fail: () => { failing = true; } };
}

test('lookup does not allocate or emit and exposes only a published opaque tool identity', () => {
    const f = fixture();
    assert.equal(f.projection.itemId('tool', 'native-private'), null);
    assert.equal(f.projection.diagnostics().items, 0); assert.equal(f.events.length, 0);
    f.projection.tool('native-private', { name: 'Read', status: 'done', output: 'ok' });
    assert.equal(f.events.length, 1);
    const event = f.events[0]!; assert.equal(event.kind, 'tool');
    assert.equal(event.itemId, 'item-1');
    assert.equal(f.projection.itemId('tool', 'native-private'), 'item-1');
    assert.equal(f.projection.itemId('message', 'native-private'), null);
    assert.ok(!JSON.stringify(f.events).includes('native-private'));
    assert.equal(f.events.length, 1); assert.equal(f.projection.diagnostics().items, 1);
});

test('recording failure invalidates earlier display mappings without inventing new events', () => {
    const f = fixture(); f.projection.tool('a', { status: 'running' });
    assert.equal(f.projection.itemId('tool', 'a'), 'item-1');
    f.fail(); f.projection.text('message', 'b', 'lost', 'replace');
    assert.equal(f.projection.itemId('tool', 'a'), null);
    assert.equal(f.projection.itemId('message', 'b'), null);
    assert.equal(f.events.length, 1);
});

test('the 161st distinct item receives no fabricated identity after the 160-item bound', () => {
    const f = fixture();
    for (let i = 0; i < 160; i++) f.projection.tool(`id-${i}`, { status: 'done' });
    assert.equal(f.events.length, 160); assert.equal(f.projection.diagnostics().items, 160);
    f.projection.tool('overflow', { status: 'running' });
    assert.equal(f.projection.itemId('tool', 'overflow'), null);
    assert.equal(f.events.length, 160); assert.equal(f.projection.diagnostics().items, 160);
});
