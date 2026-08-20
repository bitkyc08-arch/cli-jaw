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
    // /api/health lives in routes/system.ts since the Phase 2 extraction (devlog 260609, 20).
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

test('classic settings surface references transport status row outside hidden panels', () => {
    const html = read('public/index.html');
    const settingsChannel = read('public/js/features/settings-channel.ts');
    const transportRow = read('public/js/features/transport-status-row.ts');

    assert.ok(html.includes('id="channelTransportStatus"'), 'status row container must exist outside channel panels');
    assert.ok(settingsChannel.includes('refreshTransportStatusRow'), 'settings channel loader must refresh transport row');
    assert.ok(transportRow.includes("t('settings.channel.sendCapable')"), 'transport row must render send-capable label');
});

// The malformed sentinel is one element long, so a bare .length check read it as
// a configured target: /api/health answered sendCapable:true while an untargeted
// send died with "No target available for slack" (#406).
test('an unreadable slack allowlist is not a send target', async () => {
    const { settings } = await import('../../src/core/config.js');
    const previousSlack = settings.slack;
    const previousMessaging = settings.messaging;
    try {
        for (const bad of ['C_ESCAPE', null, ['']]) {
            settings.slack = { enabled: true, botToken: 'xoxb-test', appToken: 'xapp-test', channelIds: bad };

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
        }
        settings.messaging = { ...(settings.messaging || {}), lastActive: {} };
        // A readable list is still a target.
        settings.slack = { enabled: true, botToken: 'xoxb-test', appToken: 'xapp-test', channelIds: ['C_REAL'] };
        assert.equal(getTransportCapability('slack').sendCapable, true);
    } finally {
        settings.slack = previousSlack;
        settings.messaging = previousMessaging;
    }
});
