import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { settings } from '../../src/core/config.ts';
import { buildRemoteBindingKey } from '../../src/messaging/session-key.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';
import { channelGateOn } from '../../src/orchestrator/scope.ts';
import { readSource } from './source-normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const botSrc = readSource(join(__dirname, '../../src/discord/bot.ts'), 'utf8');
const gatewaySrc = readSource(join(__dirname, '../../src/orchestrator/gateway.ts'), 'utf8');

test('Discord DM, guild channel, and thread targets have independent binding keys', () => {
    const dm: RemoteTarget = {
        channel: 'discord', targetKind: 'user', peerKind: 'direct', targetId: '5555555555',
    };
    const guildChannel: RemoteTarget = {
        channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: '9876543210',
        guildId: '4444444444',
    };
    const thread: RemoteTarget = {
        channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: '1234567890',
        threadId: '1234567890', guildId: '4444444444', parentTargetId: '9876543210',
    };

    const keys = [dm, guildChannel, thread].map(buildRemoteBindingKey);
    assert.equal(new Set(keys).size, 3);
    assert.equal(keys[2], 'jaw:discord:channel:1234567890:thread:1234567890');
    assert.ok(!keys[2]!.includes(thread.parentTargetId!), 'parentTargetId must remain session-layer metadata');
});

test('Telegram General-topic normalization does not remove Discord thread suffixes', () => {
    const discordThread = (threadId: string): RemoteTarget => ({
        channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: '1234567890', threadId,
    });

    assert.equal(
        buildRemoteBindingKey(discordThread('1234567890')),
        'jaw:discord:channel:1234567890:thread:1234567890',
    );
    assert.equal(
        buildRemoteBindingKey(discordThread('1')),
        'jaw:discord:channel:1234567890:thread:1',
        'the <=1 normalization must remain Telegram-only',
    );
});

test('channelGateOn keeps Discord and Telegram opt-in while Slack remains opt-out', () => {
    const previous = settings.multiSession;
    try {
        settings.multiSession = { enabled: true, maxConcurrent: 1, midRunPolicy: 'steer' };
        assert.equal(channelGateOn('discord'), false);
        assert.equal(channelGateOn('slack'), true);
        assert.equal(channelGateOn('telegram'), false);

        settings.multiSession.channels = { discord: true };
        assert.equal(channelGateOn('discord'), true);
        assert.equal(channelGateOn('slack'), true);
        assert.equal(channelGateOn('telegram'), false);
    } finally {
        settings.multiSession = previous;
    }
});

test('gateway pins both session identifiers when a remote channel gate is off', () => {
    const start = gatewaySrc.indexOf('const multiSessionEnabled');
    const end = gatewaySrc.indexOf('const sessionScope', start);
    assert.ok(start >= 0 && end > start, 'gateway session-resolution block should be bounded');
    const block = gatewaySrc.slice(start, end);

    assert.match(block, /const chatSessionId\s*=\s*multiSessionEnabled && meta\.target && !gateOn\s*\?\s*['"]default['"]/);
    assert.match(block, /const scope\s*=\s*multiSessionEnabled\s*\?\s*\(meta\.target && !gateOn \? ['"]default['"]/);
});

test('Discord main, collect, and reset paths preserve the built target', () => {
    const mainStart = botSrc.indexOf('async function dcOrchestrate');
    const mainEnd = botSrc.indexOf("if (result.action === 'queued')", mainStart);
    assert.ok(mainStart >= 0 && mainEnd > mainStart, 'main submit block should be bounded');
    const mainBlock = botSrc.slice(mainStart, mainEnd);
    assert.match(mainBlock, /const target = buildDiscordTarget\(msg\)/);
    assert.match(mainBlock, /submitMessage\(prompt,\s*\{[\s\S]*?\btarget\b[\s,}]/);

    const collectStart = botSrc.indexOf('const collected = await orchestrateAndCollectData', mainEnd);
    // The body send migrated from channel.send chunks to the REST scheduler
    // (#417 3/3); the collect block now ends at the sendable-channel guard.
    const collectEnd = botSrc.indexOf('const channel = asSendable(msg.channel)', collectStart);
    assert.ok(collectStart >= 0 && collectEnd > collectStart, 'collect block should be bounded');
    const collectBlock = botSrc.slice(collectStart, collectEnd);
    assert.match(collectBlock, /orchestrateAndCollectData\(prompt,\s*\{[\s\S]*?\btarget\b[\s,}]/);

    const resetStart = botSrc.indexOf('// Reset intent: use submitMessage gateway for consistency');
    const resetEnd = botSrc.indexOf('dcOrchestrate(msg, text, text)', resetStart);
    assert.ok(resetStart >= 0 && resetEnd > resetStart, 'reset submit block should be bounded');
    const resetBlock = botSrc.slice(resetStart, resetEnd);
    assert.match(resetBlock, /submitMessage\(text,\s*\{\s*origin:\s*['"]discord['"],\s*target\s*\}\)/);
});
