// A gap means this connection missed something. The old check asked whether the ring's
// oldest entry was newer than the cursor, which on a shared ring says only that someone
// was busy — so a quiet tab was told to resync every time a noisy one filled the buffer.
// These tests pin the replacement: gaps come from what fell out, judged per delivery class.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    publish,
    hasReplayGap,
    currentSeq,
    setDeliveryKeyResolver,
    deliveryWatermarkCount,
    RING_SIZE,
} from '../../src/core/event-bus.ts';
import { deliveryKeyForEntry } from '../../src/core/event-scope.ts';

setDeliveryKeyResolver(deliveryKeyForEntry);

/** Pushes enough traffic to evict everything published before the call. */
function floodOut(publishOne: () => void): void {
    for (let i = 0; i < RING_SIZE + 5; i++) publishOne();
}

test('RG-1: a quiet scope is not told it missed anything', () => {
    publish('message', 'new_message', { scope: 'rg1-A', marker: 'a' });
    const cursor = currentSeq();
    // B floods the ring. A published nothing since its cursor, so it lost nothing.
    floodOut(() => publish('message', 'new_message', { scope: 'rg1-B' }));

    assert.equal(hasReplayGap(cursor, 'rg1-A'), false,
        'another scope filling the buffer is not evidence that this one missed an event');
});

test('RG-2: a scope whose own event was evicted is told', () => {
    const cursor = currentSeq();
    publish('message', 'new_message', { scope: 'rg2-A', marker: 'mine' });
    floodOut(() => publish('message', 'new_message', { scope: 'rg2-B' }));

    assert.equal(hasReplayGap(cursor, 'rg2-A'), true);
});

test('RG-2b: an instance-wide event stamped with another scope still counts', () => {
    const cursor = currentSeq();
    // broadcast() stamps whichever session was running, but every tab receives this.
    publish('settings', 'settings_change', { scope: 'rg2b-B' });
    floodOut(() => publish('message', 'new_message', { scope: 'rg2b-C' }));

    assert.equal(hasReplayGap(cursor, 'rg2b-A'), true,
        'a tab that would have received it lost it, whatever scope it carried');
});

test('RG-2c: ids surviving in the ring are not evidence of anything', () => {
    const cursor = currentSeq();
    publish('message', 'new_message', { scope: 'rg2c-B' });
    publish('message', 'new_message', { scope: 'rg2c-A' });

    // A's event sits at a higher id than the cursor with B's in between, and nothing has
    // been evicted. The old rule called that a gap.
    assert.equal(hasReplayGap(cursor, 'rg2c-A'), false);
});

test('RG-3: an unfiltered subscriber still hears about evictions', () => {
    const cursor = currentSeq();
    floodOut(() => publish('message', 'new_message', { scope: 'rg3-X' }));

    assert.equal(hasReplayGap(cursor), true, 'it receives everything, so it lost something');
});

test('RG-3b: an unfiltered subscriber counts scoped evictions too', () => {
    const cursor = currentSeq();
    publish('message', 'new_message', { scope: 'rg3b-only' });
    floodOut(() => publish('message', 'new_message', { scope: 'rg3b-other' }));

    assert.equal(hasReplayGap(cursor), true);
});

test('RG-3c: internal topics leaving the ring cost nobody anything', () => {
    const cursor = currentSeq();
    // `trace` never reaches a browser, so its eviction is not a loss for anyone.
    floodOut(() => publish('trace', 'agent:claude-e:probe', { scope: 'rg3c-A' }));

    assert.equal(hasReplayGap(cursor, 'rg3c-A'), false, 'scoped subscriber unaffected');
    assert.equal(hasReplayGap(cursor), false, 'unfiltered subscriber unaffected');
});

test('RG-3d: a compact notice belongs to the session that raised it', () => {
    const cursor = currentSeq();
    publish('system', 'system_notice', { code: 'compact_suggest', scope: 'rg3d-B' });
    floodOut(() => publish('trace', 'agent:probe', {}));

    assert.equal(hasReplayGap(cursor, 'rg3d-A'), false, 'another session’s compact hint was never A’s');
    assert.equal(hasReplayGap(cursor, 'rg3d-B'), true, 'but it was B’s');
});

test('RG-3e: an ordinary notice belongs to everyone', () => {
    const cursor = currentSeq();
    publish('system', 'system_notice', { message: 'restarting' });
    floodOut(() => publish('trace', 'agent:probe', {}));

    assert.equal(hasReplayGap(cursor, 'rg3e-A'), true);
});

test('RG-4: a cursor from before a restart is still a gap', () => {
    // Ids reset to zero when the process restarts, so a cursor ahead of the sequence means
    // the client is holding one from a previous life. That check is separate and stays.
    assert.ok(currentSeq() > 0);
    assert.equal(hasReplayGap(currentSeq() + 1000, 'rg4-A'), false,
        'the bus itself says nothing here; the route compares against currentSeq');
});

test('RG-6: a first connection is never a gap', () => {
    assert.equal(hasReplayGap(0, 'rg6-A'), false);
    assert.equal(hasReplayGap(0), false);
});

test('RG-8: watermarks are kept, and grow only with delivery classes', () => {
    const before = deliveryWatermarkCount();
    floodOut(() => publish('message', 'new_message', { scope: 'rg8-one' }));
    const afterOne = deliveryWatermarkCount();
    floodOut(() => publish('message', 'new_message', { scope: 'rg8-two' }));
    const afterTwo = deliveryWatermarkCount();

    assert.ok(afterOne > before, 'a new scope adds one entry');
    assert.ok(afterTwo > afterOne);
    assert.ok(afterTwo - before <= 4, 'two scopes plus the shared keys, not one per event');
});

test('RG-13: an old cursor is judged correctly long after the fact', () => {
    const cursor = currentSeq();
    publish('message', 'new_message', { scope: 'rg13-A' });
    // Far more traffic than the ring holds, from other scopes.
    for (let i = 0; i < RING_SIZE * 3; i++) publish('message', 'new_message', { scope: 'rg13-noise' });

    assert.equal(hasReplayGap(cursor, 'rg13-A'), true,
        'the watermark still remembers, which is why it is never pruned');
});

test('RG-11: without a resolver every eviction is treated as everyone’s', () => {
    setDeliveryKeyResolver(() => '*');
    try {
        const cursor = currentSeq();
        floodOut(() => publish('trace', 'agent:probe', { scope: 'rg11-B' }));
        assert.equal(hasReplayGap(cursor, 'rg11-A'), true,
            'the fallback over-reports rather than staying silent');
    } finally {
        setDeliveryKeyResolver(deliveryKeyForEntry);
    }
});
