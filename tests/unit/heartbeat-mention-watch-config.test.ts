// Config survival for mention-watch jobs. The failure mode this guards is
// specific: a field the UI does not know about must not vanish on an ordinary
// "Save jobs" click, and a malformed one must not leave an ENABLED job running
// its prompt with nothing to answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveHeartbeatMentionWatch } from '../../src/routes/heartbeat.ts';
import { isHeartbeatMentionWatch, HEARTBEAT_MENTION_WATCH_MAX_CHANNELS } from '../../src/core/config.ts';
import type { HeartbeatMentionWatch } from '../../src/core/config.ts';

const VALID: HeartbeatMentionWatch = {
    channel: 'slack', userId: 'U08PYEQACDN', channelIds: ['C0BDW33068P'],
};

test('a well-formed watch validates', () => {
    assert.equal(isHeartbeatMentionWatch(VALID), true);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, maxHits: 3, since: '100.000100' }), true);
});

test('an empty channel list is invalid, because enumeration is not a fallback', () => {
    // A discovered channel would be found and then refused with a 403 at send
    // time, so "watch everything" is a promise this cannot keep.
    assert.equal(isHeartbeatMentionWatch({ ...VALID, channelIds: [] }), false);
    assert.equal(isHeartbeatMentionWatch({ channel: 'slack', userId: 'U1' }), false);
});

test('a channel list past the ceiling is rejected rather than truncated', () => {
    const tooMany = Array.from({ length: HEARTBEAT_MENTION_WATCH_MAX_CHANNELS + 1 }, (_, i) => 'C' + i);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, channelIds: tooMany }), false);
    const atLimit = Array.from({ length: HEARTBEAT_MENTION_WATCH_MAX_CHANNELS }, (_, i) => 'C' + i);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, channelIds: atLimit }), true);
});

test('malformed shapes are rejected', () => {
    assert.equal(isHeartbeatMentionWatch(null), false);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, channel: 'telegram' }), false);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, userId: '' }), false);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, channelIds: ['C1', ''] }), false);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, maxHits: 0 }), false);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, maxHits: 1.5 }), false);
    assert.equal(isHeartbeatMentionWatch({ ...VALID, since: '' }), false);
});

test('an absent field INHERITS, so a UI that cannot show it does not delete it', () => {
    // Every shipped UI rebuilds a job from a fixed field set, so absence is
    // "I do not know about this", not "clear it".
    const result = resolveHeartbeatMentionWatch({ name: 'x' }, VALID);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.mentionWatch, VALID);
});

test('an explicit null clears it', () => {
    const result = resolveHeartbeatMentionWatch({ mentionWatch: null }, VALID);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.mentionWatch, undefined);
});

test('a malformed value is an error, not a silent drop', () => {
    const result = resolveHeartbeatMentionWatch({ mentionWatch: { channel: 'slack' } }, undefined);
    assert.equal(result.ok, false);
});

test('a new value replaces the old one', () => {
    const next = { ...VALID, channelIds: ['C_NEW'] };
    const result = resolveHeartbeatMentionWatch({ mentionWatch: next }, VALID);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.mentionWatch, next);
});
