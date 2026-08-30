import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldSkipForwarding } from '../../src/messaging/forwarder-origin.ts';

test('a channel skips forwarding its own turns', () => {
    assert.equal(shouldSkipForwarding({ origin: 'slack' }, 'slack'), true);
    assert.equal(shouldSkipForwarding({ origin: 'telegram' }, 'telegram'), true);
    assert.equal(shouldSkipForwarding({ origin: 'discord' }, 'discord'), true);
});

test('a turn from another chat channel still forwards', () => {
    // Cross-channel forwarding is the whole point of the forwarder.
    assert.equal(shouldSkipForwarding({ origin: 'telegram' }, 'slack'), false);
    assert.equal(shouldSkipForwarding({ origin: 'discord' }, 'slack'), false);
});

test('web, CLI and API turns still forward', () => {
    for (const origin of ['web', 'api', 'system', 'cli']) {
        assert.equal(shouldSkipForwarding({ origin }, 'slack'), false, origin);
    }
});

test('heartbeat output never rides a forwarder', () => {
    // A heartbeat job owns a destination and delivers there itself. The
    // forwarder would post the same text again, to last-active rather than the
    // configured channel — and it sees agent_done BEFORE the heartbeat's own
    // [SILENT] and reportPolicy filters run.
    for (const channel of ['slack', 'telegram', 'discord']) {
        assert.equal(shouldSkipForwarding({ origin: 'heartbeat' }, channel), true, channel);
    }
});

test('a missing or non-string origin forwards, because failing open is the bias', () => {
    assert.equal(shouldSkipForwarding({}, 'slack'), false);
    assert.equal(shouldSkipForwarding({ origin: 42 }, 'slack'), false);
    assert.equal(shouldSkipForwarding({ origin: null }, 'slack'), false);
});
