import test from 'node:test';
import assert from 'node:assert/strict';
import {
    broadcast,
    addBroadcastListener,
    removeBroadcastListener,
    setWss,
} from '../../src/core/bus.js';

test('addBroadcastListener receives broadcast events', () => {
    const received = [];
    const fn = (type, data) => received.push({ type, data });

    addBroadcastListener(fn);
    broadcast('test_event', { foo: 'bar' });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'test_event');
    assert.deepEqual(received[0].data, { foo: 'bar' });

    removeBroadcastListener(fn);
});

test('removeBroadcastListener stops receiving events', () => {
    const received = [];
    const fn = (type, data) => received.push({ type, data });

    addBroadcastListener(fn);
    broadcast('a', { n: 1 });
    assert.equal(received.length, 1);

    removeBroadcastListener(fn);
    broadcast('b', { n: 2 });
    assert.equal(received.length, 1, 'should not receive after removal');
});

test('broadcast works without WS server set', () => {
    // setWss(null) is the default — should not throw
    setWss(null);
    assert.doesNotThrow(() => broadcast('safe', {}));
});

test('broadcast sends to WS clients with readyState 1', () => {
    const sent = [];
    const mockWss = {
        clients: [
            { readyState: 1, send: (msg) => sent.push(msg) },
            { readyState: 0, send: () => { throw new Error('should not send'); } },
            { readyState: 1, send: (msg) => sent.push(msg) },
        ],
    };
    setWss(mockWss);
    broadcast('ws_test', { val: 42 });

    assert.equal(sent.length, 2);
    for (const msg of sent) {
        const parsed = JSON.parse(msg);
        assert.equal(parsed.type, 'ws_test');
        assert.equal(parsed.val, 42);
        assert.ok(parsed.ts, 'should have timestamp');
    }

    setWss(null); // cleanup
});

test('multiple listeners all receive the same broadcast', () => {
    const a = [], b = [];
    const fnA = (type) => a.push(type);
    const fnB = (type) => b.push(type);

    addBroadcastListener(fnA);
    addBroadcastListener(fnB);
    broadcast('multi', {});

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);

    removeBroadcastListener(fnA);
    removeBroadcastListener(fnB);
});

test('removing non-existent listener does not throw', () => {
    assert.doesNotThrow(() => removeBroadcastListener(() => { }));
});
