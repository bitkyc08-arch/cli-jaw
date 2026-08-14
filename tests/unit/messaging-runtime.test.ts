import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    clearTargetState,
    getEnabledChannels,
    getHomeChannel,
    getLastActiveTarget,
    getLatestSeenTarget,
    hydrateTargetsFromSettings,
    getMessagingTransportError,
    isMessagingTransportRunning,
    registerTransport,
    restartMessagingRuntime,
    setLastActiveTarget,
    setLatestSeenTarget,
    shutdownMessagingRuntime,
    startMessagingTransport,
    transportNotStarted,
    transportStarted,
    __resetTransportRegistryForTests,
    __resetTargetStateForTests,
} from '../../src/messaging/runtime.js';
import { loadSettings, settings, SETTINGS_PATH, migrateSettings } from '../../src/core/config.js';
import type { MessengerChannel, RemoteTarget } from '../../src/messaging/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function freshSettings(override: Record<string, any> = {}) {
    __resetTransportRegistryForTests();
    __resetTargetStateForTests();
    settings["messaging"] = { enabledChannels: [], homeChannel: 'telegram', lastActive: {}, latestSeen: {}, ...override.messaging };
}

function transportSpy(channel: MessengerChannel, failInit = false) {
    let initCalled = 0;
    let shutdownCalled = 0;
    registerTransport(channel, {
        init: async () => {
            initCalled++;
            if (failInit) throw new Error(`${channel} init failed`);
            return transportStarted;
        },
        shutdown: async () => { shutdownCalled++; },
    });
    return { get initCalled() { return initCalled; }, get shutdownCalled() { return shutdownCalled; } };
}

const tgTarget: RemoteTarget = { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: 'tg-1' };
const dcTarget: RemoteTarget = { channel: 'discord', targetKind: 'channel', peerKind: 'group', targetId: 'dc-1' };
const slackTarget: RemoteTarget = { channel: 'slack', targetKind: 'channel', peerKind: 'group', targetId: 'sl-1' };

test('getEnabledChannels returns messaging.enabledChannels', () => {
    freshSettings({ messaging: { enabledChannels: ['discord', 'slack'], homeChannel: 'discord' } });
    assert.deepEqual(getEnabledChannels(), ['discord', 'slack']);
});

test('getEnabledChannels filters unknown channels', () => {
    freshSettings({ messaging: { enabledChannels: ['telegram', 'unknown'], homeChannel: 'telegram' } });
    assert.deepEqual(getEnabledChannels(), ['telegram']);
});

test('getHomeChannel falls back to telegram when unset', () => {
    freshSettings({ messaging: {} });
    assert.equal(getHomeChannel(), 'telegram');
});

test('clearTargetState(channel) removes only that channel', () => {
    freshSettings({ messaging: {} });
    setLastActiveTarget('telegram', tgTarget);
    setLastActiveTarget('discord', dcTarget);
    setLatestSeenTarget('slack', slackTarget);
    clearTargetState('discord');
    assert.deepEqual(getLastActiveTarget('telegram'), tgTarget);
    assert.equal(getLastActiveTarget('discord'), null);
    assert.deepEqual(getLatestSeenTarget('slack'), slackTarget);
});

test('restartMessagingRuntime clears only affected channel targets', async () => {
    freshSettings({ messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } });
    const tg = transportSpy('telegram');
    const dc = transportSpy('discord');
    await startMessagingTransport('telegram');
    await startMessagingTransport('discord');
    setLastActiveTarget('telegram', tgTarget);
    setLastActiveTarget('discord', dcTarget);
    setLastActiveTarget('slack', slackTarget);
    await restartMessagingRuntime(
        { messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } },
        { messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } },
        { discord: { enabled: true } },
    );
    assert.equal(dc.shutdownCalled, 1, 'discord transport should shutdown');
    assert.equal(dc.initCalled, 2, 'discord transport should re-init');
    assert.equal(tg.initCalled, 1, 'telegram transport should not re-init');
    assert.equal(tg.shutdownCalled, 0, 'telegram transport should keep running');
    assert.equal(getLastActiveTarget('discord'), null, 'discord target should be cleared');
    assert.deepEqual(getLastActiveTarget('telegram'), tgTarget, 'telegram target should survive');
    assert.deepEqual(getLastActiveTarget('slack'), slackTarget, 'slack target should survive');
});

test('restartMessagingRuntime is no-op when disabled channel is patched', async () => {
    freshSettings({ messaging: { enabledChannels: ['telegram'], homeChannel: 'telegram' } });
    const tg = transportSpy('telegram');
    await startMessagingTransport('telegram');
    setLastActiveTarget('telegram', tgTarget);
    await restartMessagingRuntime(
        { messaging: { enabledChannels: ['telegram'], homeChannel: 'telegram' } },
        { messaging: { enabledChannels: ['telegram'], homeChannel: 'telegram' } },
        { discord: { token: 'x' } },
    );
    assert.equal(tg.shutdownCalled, 0, 'telegram transport should stay running');
    assert.deepEqual(getLastActiveTarget('telegram'), tgTarget, 'telegram target should survive');
});

test('restartMessagingRuntime restarts enabled channels on locale patch', async () => {
    freshSettings({ messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } });
    const tg = transportSpy('telegram');
    const dc = transportSpy('discord');
    await startMessagingTransport('telegram');
    await startMessagingTransport('discord');
    await restartMessagingRuntime(
        { messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } },
        { messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } },
        { locale: 'ko' },
    );
    assert.equal(tg.shutdownCalled, 1);
    assert.equal(dc.shutdownCalled, 1);
    assert.equal(tg.initCalled, 2);
    assert.equal(dc.initCalled, 2);
});

test('homeChannel-only patch does not restart inbound transports', async () => {
    freshSettings({ messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } });
    const tg = transportSpy('telegram');
    const dc = transportSpy('discord');
    await startMessagingTransport('telegram');
    await startMessagingTransport('discord');
    await restartMessagingRuntime(
        { messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } },
        { messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'discord' } },
        { messaging: { homeChannel: 'discord' } },
    );
    assert.equal(tg.shutdownCalled, 0);
    assert.equal(dc.shutdownCalled, 0);
    assert.equal(tg.initCalled, 1);
    assert.equal(dc.initCalled, 1);
});

test('hydrateTargetsFromSettings restores channel-scoped targets', () => {
    freshSettings({ messaging: { enabledChannels: ['telegram'], homeChannel: 'telegram' } });
    hydrateTargetsFromSettings({
        messaging: {
            enabledChannels: ['telegram', 'discord'],
            homeChannel: 'telegram',
            lastActive: { telegram: tgTarget, discord: dcTarget },
            latestSeen: { slack: slackTarget },
        },
    });
    assert.deepEqual(getLastActiveTarget('telegram'), tgTarget);
    assert.deepEqual(getLastActiveTarget('discord'), dcTarget);
    assert.equal(getLastActiveTarget('slack'), null);
    assert.deepEqual(getLatestSeenTarget('slack'), slackTarget);
});

test('shutdownMessagingRuntime stops all registered transports', async () => {
    freshSettings({ messaging: { enabledChannels: ['telegram', 'discord'], homeChannel: 'telegram' } });
    const tg = transportSpy('telegram');
    const dc = transportSpy('discord');
    await startMessagingTransport('telegram');
    await startMessagingTransport('discord');
    await shutdownMessagingRuntime();
    assert.equal(tg.shutdownCalled, 1);
    assert.equal(dc.shutdownCalled, 1);
});

test('startMessagingTransport records transport errors without throwing', async () => {
    freshSettings({ messaging: { enabledChannels: ['discord'], homeChannel: 'telegram' } });
    transportSpy('discord', true);
    const outcome = await startMessagingTransport('discord');
    assert.equal(outcome.started, false);
    // A throw is a fault, so it must land in the reason that health treats as an
    // incident — not in one of the states an operator deliberately chose.
    assert.equal(outcome.started === false && outcome.reason, 'failed');
});

test('startMessagingTransport keeps a declined start out of the error record', async () => {
    freshSettings({ messaging: { enabledChannels: ['slack'], homeChannel: 'slack' } });
    registerTransport('slack', {
        init: async () => transportNotStarted('not_attach_instance'),
        shutdown: async () => {},
    });
    const outcome = await startMessagingTransport('slack');
    assert.equal(outcome.started, false);
    assert.equal(outcome.started === false && outcome.reason, 'not_attach_instance');
    assert.equal(isMessagingTransportRunning('slack'), false);
    // The non-attach instance is doing exactly what it was configured to do, so it
    // must not leave a transport error behind for health to report as a fault.
    assert.equal(getMessagingTransportError('slack'), null);
});

test('loadSettings migrates legacy channel to messaging.enabledChannels and homeChannel', () => {
    const raw = JSON.stringify({
        settingsSchemaVersion: 3,
        channel: 'slack',
        cli: 'codex',
        multiSession: { enabled: true, maxConcurrent: 2 },
        multiSessionDefaultMigration: { id: 'multi-session-default-v3', state: 'accepted' },
        telegram: { enabled: true, token: '' },
    });
    writeFileSync(SETTINGS_PATH, raw);
    loadSettings();
    assert.equal(settings.channel, undefined);
    assert.deepEqual(settings.messaging.enabledChannels, ['slack']);
    assert.equal(settings.messaging.homeChannel, 'slack');
    assert.equal(settings.settingsSchemaVersion, 4);
    unlinkSync(SETTINGS_PATH);
});

test('migrateSettings normalizes duplicate enabledChannels without reordering', () => {
    const migrated = migrateSettings({
        settingsSchemaVersion: 4,
        channel: 'discord',
        messaging: { enabledChannels: ['discord', 'discord', 'telegram'], homeChannel: 'discord' },
    });
    assert.deepEqual(migrated.messaging.enabledChannels, ['discord', 'telegram']);
    assert.equal(migrated.messaging.homeChannel, 'discord');
});

test('applyRuntimeSettingsPatch is async and awaits restart', () => {
    const runtimeSettingsSrc = readFileSync(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');
    assert.match(runtimeSettingsSrc, /export async function applyRuntimeSettingsPatch/, 'must be async function');
    assert.match(runtimeSettingsSrc, /await \(opts\.restartMessaging \?\? restartMessagingRuntime\)\(/, 'must await the messaging restart');
});
