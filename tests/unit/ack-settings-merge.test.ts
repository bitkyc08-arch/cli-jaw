import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettingsPatch } from '../../src/core/settings-merge.ts';
import { SLACK_ACK_DEFAULTS } from '../../src/messaging/ack-reaction.ts';

// The ack group is nested inside a channel object, and every channel merge in
// this repo is one level deep. Without a nested merge a PUT carrying a single
// ack key silently drops its siblings — which is how a user turning the feature
// on would also erase their emoji choices.

function currentWithAck() {
    return {
        slack: {
            enabled: true,
            botToken: 'xoxb-test',
            ack: {
                enabled: false,
                scope: 'group-mentions',
                emoji: { running: 'eyes', success: 'white_check_mark', failure: 'x' },
                removeAfterReply: false,
            },
        },
        telegram: { enabled: true, ack: { enabled: false, scope: 'direct', emoji: { running: 'a', success: 'b', failure: 'c' }, removeAfterReply: false } },
        discord: { enabled: false, ack: { ...SLACK_ACK_DEFAULTS, emoji: { ...SLACK_ACK_DEFAULTS.emoji } } },
    } as Record<string, any>;
}

test('API patch: enabling ack preserves scope, emoji and removeAfterReply', () => {
    const result = mergeSettingsPatch(currentWithAck(), { slack: { ack: { enabled: true } } });
    const ack = result["slack"].ack;
    assert.equal(ack.enabled, true, 'the patched key must apply');
    assert.equal(ack.scope, 'group-mentions', 'sibling scope must survive');
    assert.deepEqual(ack.emoji, { running: 'eyes', success: 'white_check_mark', failure: 'x' });
    assert.equal(ack.removeAfterReply, false);
});

test('API patch: a partial emoji patch keeps the states it did not mention', () => {
    const result = mergeSettingsPatch(currentWithAck(), { slack: { ack: { emoji: { running: 'wave' } } } });
    assert.deepEqual(result["slack"].ack.emoji, { running: 'wave', success: 'white_check_mark', failure: 'x' });
});

test('a channel patch that never mentions ack leaves it untouched', () => {
    const result = mergeSettingsPatch(currentWithAck(), { slack: { mentionOnly: false } });
    assert.equal(result["slack"].mentionOnly, false);
    assert.equal(result["slack"].ack.scope, 'group-mentions');
    assert.deepEqual(result["slack"].ack.emoji, { running: 'eyes', success: 'white_check_mark', failure: 'x' });
});

test('each channel merges its own ack independently', () => {
    const result = mergeSettingsPatch(currentWithAck(), {
        slack: { ack: { enabled: true } },
        telegram: { ack: { emoji: { success: 'z' } } },
    });
    assert.equal(result["slack"].ack.enabled, true);
    assert.equal(result["slack"].ack.scope, 'group-mentions');
    assert.equal(result["telegram"].ack.scope, 'direct', 'telegram scope must survive its own patch');
    assert.deepEqual(result["telegram"].ack.emoji, { running: 'a', success: 'z', failure: 'c' });
    assert.equal(result["discord"].ack.scope, SLACK_ACK_DEFAULTS.scope, 'an unpatched channel is untouched');
});

test('mergeSettingsPatch does not mutate the input settings', () => {
    const current = currentWithAck();
    mergeSettingsPatch(current, { slack: { ack: { enabled: true, emoji: { running: 'wave' } } } });
    assert.equal(current["slack"].ack.enabled, false, 'source settings must be left alone');
    assert.equal(current["slack"].ack.emoji.running, 'eyes');
});

test('an ack patch on a channel with no prior ack still lands', () => {
    const result = mergeSettingsPatch({ slack: { enabled: true } }, { slack: { ack: { enabled: true } } });
    assert.equal(result["slack"].ack.enabled, true);
});

test('a malformed ack patch cannot crash the merge', () => {
    for (const bad of [null, 'nope', 42, [1, 2]]) {
        const result = mergeSettingsPatch(currentWithAck(), { slack: { ack: bad } });
        // Either the bad value is ignored or it lands verbatim, but the merge
        // must not throw and must not corrupt the other channels.
        assert.equal(result["telegram"].ack.scope, 'direct');
    }
});

