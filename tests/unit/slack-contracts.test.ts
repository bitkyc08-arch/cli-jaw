import test from 'node:test';
import assert from 'node:assert/strict';
import {
    slackPeerKind,
    slackTargetKind,
    slackTargetFromId,
    resolveSlackThreadTs,
} from '../../src/messaging/slack-target.ts';
import { DEFAULT_SETTINGS, migrateSettings, settings } from '../../src/core/config.ts';
import { validateTarget } from '../../src/messaging/send.ts';
import { getTransportCapability, buildChannelHealthSnapshot } from '../../src/messaging/channel-health.ts';

// ─── Settings schema ────────────────────────────────

test('defaults include a complete slack block', () => {
    const sc = (DEFAULT_SETTINGS as Record<string, any>)['slack'];
    assert.ok(sc, 'slack defaults missing');
    assert.equal(sc.enabled, false);
    assert.equal(sc.botToken, '');
    assert.equal(sc.appToken, '');
    // Slack bots live in shared channels; answering everything is antisocial.
    assert.equal(sc.mentionOnly, true, 'slack mentionOnly must default true');
    assert.equal(sc.replyInThread, true, 'slack replyInThread must default true');
});

test('defaults carry slack messaging target slots', () => {
    const m = (DEFAULT_SETTINGS as Record<string, any>)['messaging'];
    assert.equal(m.latestSeen.slack, null);
    assert.equal(m.lastActive.slack, null);
});

test('migration adds a slack block to legacy settings', () => {
    const legacy: Record<string, any> = {
        channel: 'telegram',
        discord: { enabled: false, token: '' },
    };
    const migrated = migrateSettings(legacy) as Record<string, any>;
    assert.ok(migrated['slack'], 'migration did not add slack');
    assert.equal(migrated['slack'].mentionOnly, true);
    assert.equal(migrated['slack'].replyInThread, true);
});

test('migration backfills slack slots into an EXISTING messaging block', () => {
    // Regression guard: a bare `if (!s.messaging)` would never reach existing
    // installs, which all already have a messaging block.
    const legacy: Record<string, any> = {
        channel: 'telegram',
        messaging: {
            latestSeen: { telegram: null, discord: null },
            lastActive: { telegram: null, discord: null },
        },
    };
    const migrated = migrateSettings(legacy) as Record<string, any>;
    assert.equal(migrated['messaging'].latestSeen.slack, null);
    assert.equal(migrated['messaging'].lastActive.slack, null);
});

// ─── Target derivation ──────────────────────────────

test('slackPeerKind classifies by id prefix', () => {
    assert.equal(slackPeerKind('C12345'), 'channel');
    assert.equal(slackPeerKind('G12345'), 'group');
    assert.equal(slackPeerKind('D12345'), 'direct');
    // A user id is not a conversation, but it resolves to a DM.
    assert.equal(slackPeerKind('U12345'), 'direct');
    assert.equal(slackPeerKind('d12345'), 'direct', 'prefix match must be case-insensitive');
});

test('slackTargetKind maps direct conversations to user targets', () => {
    assert.equal(slackTargetKind('D123'), 'user');
    assert.equal(slackTargetKind('U123'), 'user');
    assert.equal(slackTargetKind('C123'), 'channel');
    assert.equal(slackTargetKind('G123'), 'channel');
});

test('slackTargetFromId omits threadId when no thread is supplied', () => {
    const target = slackTargetFromId('C123');
    assert.equal(target.channel, 'slack');
    assert.equal(target.targetId, 'C123');
    assert.ok(!('threadId' in target), 'threadId key must be absent, not undefined');
    assert.ok(!('guildId' in target));
});

test('slackTargetFromId carries thread and team when supplied', () => {
    const target = slackTargetFromId('C123', { threadTs: '1735.0001', teamId: 'T999' });
    assert.equal(target.threadId, '1735.0001');
    assert.equal(target.guildId, 'T999');
});

// ─── Threading (highest-risk rule in the unit) ──────

test('resolveSlackThreadTs starts a thread from a top-level message', () => {
    assert.equal(resolveSlackThreadTs({ ts: '1.1' }, true), '1.1');
});

test('resolveSlackThreadTs replies to the PARENT ts, never the reply ts', () => {
    // Slack requires the parent's ts. Using the reply's own ts breaks the thread.
    assert.equal(resolveSlackThreadTs({ ts: '2.2', thread_ts: '1.1' }, true), '1.1');
});

test('resolveSlackThreadTs with replyInThread off stays top-level', () => {
    assert.equal(resolveSlackThreadTs({ ts: '1.1' }, false), undefined);
    assert.equal(resolveSlackThreadTs({ ts: '2.2', thread_ts: '1.1' }, false), '1.1');
});

// ─── Allowlist ──────────────────────────────────────

function withSlackSettings<T>(patch: Record<string, unknown>, fn: () => T): T {
    const prior = (settings as Record<string, any>)['slack'];
    (settings as Record<string, any>)['slack'] = patch;
    try {
        return fn();
    } finally {
        (settings as Record<string, any>)['slack'] = prior;
    }
}

test('validateTarget lets a DM through an empty allowlist', () => {
    withSlackSettings({ enabled: true, channelIds: [] }, () => {
        const target = slackTargetFromId('D123');
        assert.equal(validateTarget(target, 'slack', { requireConfiguredAllowlist: true }), true);
    });
});

test('validateTarget lets a U-id through so the DM-open path can run', () => {
    withSlackSettings({ enabled: true, channelIds: ['C123'] }, () => {
        const target = slackTargetFromId('U777');
        assert.equal(validateTarget(target, 'slack', { requireConfiguredAllowlist: true }), true);
    });
});

test('validateTarget enforces the channel allowlist', () => {
    withSlackSettings({ enabled: true, channelIds: ['C123'] }, () => {
        assert.equal(validateTarget(slackTargetFromId('C123'), 'slack'), true);
        assert.equal(validateTarget(slackTargetFromId('C999'), 'slack'), false);
    });
});

// ─── Health ─────────────────────────────────────────

test('slack health reports disabled without a bot token', () => {
    withSlackSettings({ enabled: false }, () => {
        const cap = getTransportCapability('slack');
        assert.equal(cap.configured, false);
        assert.equal(cap.reason, 'disabled');
    });
});

test('slack health reports missing_app_token for outbound-only setups', () => {
    // Bot token alone: can post, can never receive. Say so precisely.
    withSlackSettings({ enabled: true, botToken: 'xoxb-x', channelIds: ['C123'] }, () => {
        const cap = getTransportCapability('slack');
        assert.equal(cap.configured, true);
        assert.equal(cap.reason, 'missing_app_token');
        assert.equal(cap.sendCapable, true);
    });
});

test('slack health reports missing_channel_id with both tokens and no target', () => {
    withSlackSettings({ enabled: true, botToken: 'xoxb-x', appToken: 'xapp-x', channelIds: [] }, () => {
        const cap = getTransportCapability('slack');
        assert.equal(cap.sendCapable, false);
        assert.equal(cap.reason, 'missing_channel_id');
    });
});

test('slack health reports ready when fully configured', () => {
    withSlackSettings({ enabled: true, botToken: 'xoxb-x', appToken: 'xapp-x', channelIds: ['C123'] }, () => {
        const cap = getTransportCapability('slack');
        assert.equal(cap.configured, true);
        assert.equal(cap.sendCapable, true);
        assert.equal(cap.reason, undefined);
    });
});

test('channel health snapshot includes slack', () => {
    const snap = buildChannelHealthSnapshot();
    assert.ok('slack' in snap, 'health snapshot is missing the slack key');
});
