import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusUpdateBuffer } from '../../src/telegram/status-update-buffer.js';

test('status update buffer consumes a snapshot exactly once', () => {
    const buffer = new StatusUpdateBuffer();
    buffer.set('first');
    assert.equal(buffer.take(), 'first');
    assert.equal(buffer.hasPending(), false);
    assert.equal(buffer.take(), '');
});

test('status update buffer preserves an update that arrives after take', () => {
    const buffer = new StatusUpdateBuffer();
    buffer.set('first');
    assert.equal(buffer.take(), 'first');
    buffer.set('second');
    assert.equal(buffer.hasPending(), true);
    assert.equal(buffer.take(), 'second');
});
