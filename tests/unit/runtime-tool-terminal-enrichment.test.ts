import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';
// The projection receives its recorder; importing it must not create a database.
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => null } });
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');

function fixture() {
    const events: RuntimeEvent[] = [];
    const projection = new RuntimeProjection({ runId: 'r', sessionId: 's', scope: 'scope', turnId: 't', audience: 'internal' },
        (context, body) => { const event = { ...context, version: 1 as const, seq: events.length * 3 + 2, ...body }; events.push(event); return event; }, () => {});
    projection.start('claude');
    return { projection, events, tool: () => events.filter(e => e.kind === 'tool').at(-1)! };
}
test('late start enriches missing terminal metadata without reopening or changing result', () => {
    const f = fixture();
    f.projection.tool('id', { status: 'error', output: 'result', detail: 'failure' });
    const id = f.tool().itemId;
    f.projection.tool('id', { name: 'Read', input: '{"path":"a"}', inputStructured: true, status: 'running', output: 'wrong', detail: 'wrong' });
    assert.equal(f.tool().name, 'Read'); assert.equal(f.tool().input, '{"path":"a"}');
    assert.equal(f.tool().itemId, id); assert.equal(f.tool().status, 'error');
    assert.equal(f.tool().output, 'result'); assert.equal(f.tool().detail, 'failure');
    const count = f.events.length;
    f.projection.tool('id', { name: 'Overwrite', input: 'overwrite', status: 'done', output: 'overwrite' });
    assert.equal(f.events.length, count);
});
test('late input uses existing structured redaction and malformed content withholding', () => {
    const f = fixture();
    f.projection.tool('a', { status: 'done' });
    f.projection.tool('a', { name: 'tool', input: '{"api_key":"secret-value","path":"safe"}', inputStructured: true });
    assert.ok(!JSON.stringify(f.events).includes('secret-value'));
    f.projection.tool('b', { status: 'stopped' });
    f.projection.tool('b', { input: '{"token":"secret-fragment', inputStructured: true });
    assert.ok(!JSON.stringify(f.events).includes('secret-fragment'));
    assert.equal(f.tool().status, 'stopped');
});
test('terminal enrichment respects preview budgets and closed projection boundary', () => {
    const f = fixture();
    f.projection.tool('id', { status: 'done', output: 'ok' });
    f.projection.tool('id', { name: 'N'.repeat(200), input: 'x'.repeat(100_000) });
    assert.ok(f.tool().name.length <= 120); assert.ok((f.tool().input?.length ?? 0) <= 3000);
    assert.ok(f.projection.diagnostics().withinSnapshotCap);
    f.projection.close({ kind: 'turn-end', status: 'done', finalText: null });
    const count = f.events.length; f.projection.tool('id', { name: 'late' });
    assert.equal(f.events.length, count);
});
test('known terminal metadata and ordinary start-complete sequence remain immutable', () => {
    const f = fixture();
    f.projection.tool('id', { name: 'command', input: 'pwd', status: 'running' });
    f.projection.tool('id', { status: 'done', output: '/tmp' });
    const count = f.events.length;
    f.projection.tool('id', { name: 'other', input: 'rm', status: 'running', output: 'overwrite' });
    assert.equal(f.events.length, count); assert.equal(f.tool().input, 'pwd'); assert.equal(f.tool().output, '/tmp');
});
test('saturated aggregate budget rejects enrichment instead of erasing terminal output', () => {
    const f = fixture();
    f.projection.tool('target', { status: 'done', output: 'R'.repeat(1000), detail: 'D'.repeat(1000) });
    const original = f.tool();
    for (let i = 0; i < 7; i++) f.projection.tool(`fill-${i}`, { status: 'done', output: 'F'.repeat(3000) });
    assert.ok(f.projection.diagnostics().previewChars > 21_000);
    f.projection.tool('target', { name: 'Read', input: 'I'.repeat(3000), status: 'running' });
    const target = f.events.filter(e => e.kind === 'tool' && e.itemId === original.itemId).at(-1)!;
    assert.equal(target.output, original.output); assert.equal(target.detail, original.detail); assert.equal(target.status, 'done');
});
