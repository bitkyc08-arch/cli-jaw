import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChannelHealthSnapshot, getTransportCapability } from '../../src/messaging/channel-health.ts';
import { parseChannelHealth, transportChipLabels } from '../../public/js/features/transport-status-row.ts';
import { parseChannelHealth as parseManagerChannelHealth, transportChipLabels as managerTransportChipLabels } from '../../public/manager/src/settings/pages/components/TransportStatusChips.tsx';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relPath: string): string {
    return readFileSync(join(root, relPath), 'utf8');
}

test('channel-health exports capability snapshot for /api/health', () => {
    // /api/health lives in routes/system.ts since the Phase 2 extraction.
    const server = read('src/routes/system.ts');
    const messaging = read('src/routes/messaging.ts');
    const runtimeSettings = read('src/core/runtime-settings.ts');

    assert.ok(server.includes('buildChannelHealthSnapshot()'), 'health endpoint must expose channels snapshot');
    assert.ok(messaging.includes('sendResultHttpStatus'), 'messaging routes must honor send result status');
    assert.ok(runtimeSettings.includes('invalidateSendOnlyClientsIfNeeded'), 'settings patch must invalidate send-only clients');
});

test('getTransportCapability returns structured transport fields', () => {
    const telegram = getTransportCapability('telegram');
    const discord = getTransportCapability('discord');
    for (const row of [telegram, discord]) {
        assert.equal(typeof row.configured, 'boolean');
        assert.equal(typeof row.activeInbound, 'boolean');
        assert.equal(typeof row.sendCapable, 'boolean');
    }
});

test('buildChannelHealthSnapshot includes both transports', () => {
    const snapshot = buildChannelHealthSnapshot();
    assert.ok(snapshot.activeInbound === 'telegram' || snapshot.activeInbound === 'discord');
    assert.ok(snapshot.telegram);
    assert.ok(snapshot.discord);
});

test('classic transport status row parses health.channels', () => {
    const snapshot = buildChannelHealthSnapshot();
    const parsed = parseChannelHealth({ channels: snapshot });
    assert.deepEqual(parsed?.telegram, snapshot.telegram);
    assert.deepEqual(parsed?.discord, snapshot.discord);
    assert.ok(transportChipLabels(snapshot.telegram).length >= 1);
});

test('manager transport chips parse health.channels', () => {
    const snapshot = buildChannelHealthSnapshot();
    const parsed = parseManagerChannelHealth({ channels: snapshot });
    assert.deepEqual(parsed?.telegram, snapshot.telegram);
    assert.ok(managerTransportChipLabels(snapshot.discord).includes('Configured') || managerTransportChipLabels(snapshot.discord).includes('Not configured'));
});

test('shared settings channel pages expose live transport capability', () => {
    assert.match(read('public/index.html'), /class="settings-frame" src="dist\/settings\/index.html"/);
    for (const channel of ['telegram', 'discord', 'slack']) {
        const page = read(`public/manager/src/settings/pages/Channels${channel[0]!.toUpperCase()}${channel.slice(1)}.tsx`);
        assert.match(page, new RegExp(`<TransportStatusChips[^>]*channel="${channel}"`));
    }
    const chips = read('public/manager/src/settings/pages/components/TransportStatusChips.tsx');
    assert.match(chips, /client.get<unknown>\('\/api\/health'\)/);
    assert.match(chips, /role="status" aria-live="polite"/);
    assert.match(chips, /transportChipLabels\(status\)/);
});

// The malformed sentinel is one element long, so a bare .length check read it as
// a configured target: /api/health answered sendCapable:true while an untargeted
// send died with "No target available for slack" (#406).
test('an unreadable slack allowlist is not a send target', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { setLastActiveTarget, clearTargetState } = await import('../../src/messaging/runtime.js');
    const previousSlack = settings.slack;
    const previousMessaging = settings.messaging;
    try {
        for (const bad of ['C_ESCAPE', null, ['']]) {
            settings.slack = { enabled: true, botToken: 'xoxb-test', appToken: 'xapp-test', channelIds: bad };

            clearTargetState('slack');
            settings.messaging = { ...(settings.messaging || {}), lastActive: {} };
            assert.equal(
                getTransportCapability('slack').sendCapable, false,
                `health must not vouch for an allowlist the gate denies: ${JSON.stringify(bad)}`,
            );

            // The slot is where the first fix leaked: health fell through to it
            // and answered true for a channel validateTarget was refusing.
            settings.messaging = {
                ...(settings.messaging || {}),
                lastActive: { slack: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_STALE' } },
            };
            assert.equal(
                getTransportCapability('slack').sendCapable, false,
                'a last-active channel is denied by the same unreadable allowlist',
            );

            // A DM is self-authorizing on both sides, so reporting false here
            // would understate a send that does work.
            settings.messaging = {
                ...(settings.messaging || {}),
                lastActive: { slack: { channel: 'slack', targetKind: 'user', peerKind: 'direct', targetId: 'D_USER' } },
            };
            assert.equal(
                getTransportCapability('slack').sendCapable, true,
                'DMs stay reachable, as validateTarget allows them before reading the allowlist',
            );

            // A slot that is not a full RemoteTarget is dropped by
            // hydrateTargetsFromSettings, so vouching for it on the id prefix
            // alone promises a send that dies with "No target available".
            settings.messaging = {
                ...(settings.messaging || {}),
                lastActive: { slack: { targetId: 'D_FAKE' } },
            };
            assert.equal(
                getTransportCapability('slack').sendCapable, false,
                'a malformed slot is not a DM target just because its id starts with D',
            );

            // The runtime slot is what a send actually uses. It is set the moment
            // a conversation speaks and only reaches settings 5s later, so
            // reading the file alone called a live DM unreachable.
            settings.messaging = { ...(settings.messaging || {}), lastActive: {} };
            setLastActiveTarget('slack', {
                channel: 'slack', targetKind: 'user', peerKind: 'direct', targetId: 'D_LIVE',
            });
            assert.equal(
                getTransportCapability('slack').sendCapable, true,
                'a live DM target is reachable before it is ever persisted',
            );
            clearTargetState('slack');
        }
        settings.messaging = { ...(settings.messaging || {}), lastActive: {} };
        // A readable list is still a target.
        settings.slack = { enabled: true, botToken: 'xoxb-test', appToken: 'xapp-test', channelIds: ['C_REAL'] };
        assert.equal(getTransportCapability('slack').sendCapable, true);
    } finally {
        clearTargetState('slack');
        settings.slack = previousSlack;
        settings.messaging = previousMessaging;
    }
});
