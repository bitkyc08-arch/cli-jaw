import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.js';
import { createTraceId, startTraceRun } from '../../src/trace/store.js';

test('exported trace identity allocator keeps the existing format and needs no available database', () => {
    const admitted = startTraceRun({ cli: 'fixture' });
    db.close();
    const fallback = createTraceId();
    assert.match(admitted, /^tr_[a-f0-9]{32}$/);
    assert.match(fallback, /^tr_[a-f0-9]{32}$/);
    assert.notEqual(fallback, admitted);
});
