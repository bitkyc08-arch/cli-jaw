// slack.autoJoin at its two real seams: the boot merge in config.ts and the
// API/watch patch path in settings-merge.ts.
//
// Unit-testing mergeSlackAutoJoin alone proves the function works, not that
// either ingress calls it. These tests drive the seams themselves, because the
// failure being guarded against is a nested default that never reaches an
// existing install and a PUT that erases a budget it never mentioned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettingsPatch } from '../../src/core/settings-merge.ts';
import { SLACK_AUTO_JOIN_DEFAULTS } from '../../src/slack/auto-join.ts';

function currentWithAutoJoin() {
    return {
        slack: {
            enabled: true,
            botToken: 'xoxb-test',
            autoJoin: {
                enabled: true,
                excludeArchived: true,
                maxJoinsPerRun: 42,
                exclude: ['C_KEEP'],
            },
        },
    } as Record<string, any>;
}

test('API patch: disabling auto-join preserves the budget and exclude list', () => {
    const result = mergeSettingsPatch(currentWithAutoJoin(), {
        slack: { autoJoin: { enabled: false } },
    });
    const autoJoin = result['slack'].autoJoin;
    assert.equal(autoJoin.enabled, false, 'the patched key must apply');
    assert.equal(autoJoin.maxJoinsPerRun, 42, 'a one-key patch must not erase the budget');
    assert.deepEqual(autoJoin.exclude, ['C_KEEP'], 'nor the exclude list');
    assert.equal(autoJoin.excludeArchived, true);
});

test('API patch: a malformed budget is repaired at the boundary', () => {
    // This value reaches a loop that joins real channels. -1 must never get
    // there, and neither must the string that a form post would produce.
    const negative = mergeSettingsPatch(currentWithAutoJoin(), {
        slack: { autoJoin: { maxJoinsPerRun: -5 } },
    });
    assert.equal(negative['slack'].autoJoin.maxJoinsPerRun, 1);

    const oversized = mergeSettingsPatch(currentWithAutoJoin(), {
        slack: { autoJoin: { maxJoinsPerRun: 100000 } },
    });
    assert.equal(oversized['slack'].autoJoin.maxJoinsPerRun, 1000);

    const nonNumeric = mergeSettingsPatch(currentWithAutoJoin(), {
        slack: { autoJoin: { maxJoinsPerRun: 'all of them' } },
    });
    assert.equal(nonNumeric['slack'].autoJoin.maxJoinsPerRun,
        SLACK_AUTO_JOIN_DEFAULTS.maxJoinsPerRun);
});

test('API patch: a stored install with no autoJoin block still gets a valid one', () => {
    const result = mergeSettingsPatch(
        { slack: { enabled: true, botToken: 'xoxb-test' } } as Record<string, any>,
        { slack: { autoJoin: { enabled: false } } },
    );
    const autoJoin = result['slack'].autoJoin;
    assert.equal(autoJoin.enabled, false);
    assert.equal(autoJoin.maxJoinsPerRun, SLACK_AUTO_JOIN_DEFAULTS.maxJoinsPerRun);
    assert.deepEqual(autoJoin.exclude, []);
});

test('API patch: ack and autoJoin survive each other', () => {
    // Both are nested groups on the same channel object and both are repaired
    // by the same loop; a patch touching one must not flatten the other.
    const current = {
        slack: {
            enabled: true,
            ack: { enabled: false, scope: 'group-mentions', emoji: { running: 'eyes' }, removeAfterReply: false },
            autoJoin: { enabled: true, excludeArchived: true, maxJoinsPerRun: 7, exclude: ['C_X'] },
        },
    } as Record<string, any>;
    const result = mergeSettingsPatch(current, { slack: { ack: { enabled: true } } });
    assert.equal(result['slack'].ack.enabled, true);
    assert.equal(result['slack'].autoJoin.maxJoinsPerRun, 7,
        'patching ack must leave autoJoin untouched');
    assert.deepEqual(result['slack'].autoJoin.exclude, ['C_X']);
});

test('API patch: an unrelated slack patch does not invent an autoJoin block', () => {
    // The merge only rebuilds what the patch mentions. A file that never had
    // the block must not gain one from an unrelated token update — the boot
    // merge owns defaulting, and writing them here would persist a decision
    // the user never made.
    const untouched = mergeSettingsPatch(
        { slack: { enabled: true } } as Record<string, any>,
        { slack: { botToken: 'xoxb-new' } },
    );
    assert.equal(untouched['slack'].autoJoin, undefined,
        'an unrelated patch must not write an autoJoin block');

    // And an existing block survives an unrelated patch untouched.
    const preserved = mergeSettingsPatch(
        { slack: { enabled: true, autoJoin: { enabled: false, excludeArchived: true, maxJoinsPerRun: 3, exclude: [] } } } as Record<string, any>,
        { slack: { botToken: 'xoxb-new' } },
    );
    assert.equal(preserved['slack'].autoJoin.maxJoinsPerRun, 3);
    assert.equal(preserved['slack'].autoJoin.enabled, false);
});

test('API patch: a malformed whole block is repaired, never stored as-is', () => {
    // The dangerous shape: null survives a one-level spread, reaches disk, and
    // the next boot reads it as "no block configured" — silently restoring
    // default-on for a user who asked for the opposite.
    for (const bad of [null, 'yes', 42, []]) {
        const result = mergeSettingsPatch(currentWithAutoJoin(), {
            slack: { autoJoin: bad },
        });
        const autoJoin = result['slack'].autoJoin;
        assert.equal(typeof autoJoin, 'object', `autoJoin must stay an object for ${JSON.stringify(bad)}`);
        assert.ok(autoJoin !== null, 'never null');
        assert.equal(typeof autoJoin.enabled, 'boolean');
        assert.equal(autoJoin.maxJoinsPerRun, 42,
            'a malformed patch must not erase the stored budget');
        assert.deepEqual(autoJoin.exclude, ['C_KEEP']);
    }
});
