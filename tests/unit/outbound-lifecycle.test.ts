// #417 — outbound send cancellation. The registry is the shutdown half; each
// channel's plumbing is proven in its own suite. These pin the contract:
// drain aborts every in-flight scope, done() releases, abort is observable
// as an AbortSignal (what the HTTP layers consume), and abortableDelay wakes
// early instead of sitting out a rate-limit window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboundSendRegistry, abortableDelay } from '../../src/messaging/outbound-lifecycle.ts';

test('OSR-001: drain aborts every in-flight scope and empties the registry', async () => {
    const registry = new OutboundSendRegistry();
    const a = registry.start();
    const b = registry.start();
    assert.equal(registry.size, 2);
    await registry.drain(10);
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
    assert.equal(registry.size, 0);
});

test('OSR-002: done() releases a scope so drain does not touch it', async () => {
    const registry = new OutboundSendRegistry();
    const settled = registry.start();
    settled.done();
    const inflight = registry.start();
    await registry.drain(10);
    assert.equal(settled.signal.aborted, false, 'a completed send is not retro-aborted');
    assert.equal(inflight.signal.aborted, true);
});

test('OSR-003: a parent abort propagates into the scope', () => {
    const registry = new OutboundSendRegistry();
    const parent = new AbortController();
    const scope = registry.start(parent.signal);
    assert.equal(scope.signal.aborted, false);
    parent.abort(new Error('ingress gone'));
    assert.equal(scope.signal.aborted, true);
    scope.done();
    assert.equal(registry.size, 0);
});

test('OSR-004: abortableDelay wakes early on abort instead of sitting out the window', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const wait = abortableDelay(60_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await wait;
    assert.ok(Date.now() - started < 5_000, 'the 60s sleep must end at the abort');
});

test('OSR-005: an already-aborted parent yields an aborted scope immediately', () => {
    const registry = new OutboundSendRegistry();
    const parent = new AbortController();
    parent.abort();
    const scope = registry.start(parent.signal);
    assert.equal(scope.signal.aborted, true);
    scope.done();
});
