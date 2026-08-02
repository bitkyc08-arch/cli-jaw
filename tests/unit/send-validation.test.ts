// Send validation behavior tests — Phase 9
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── validateTarget behavior ─────────────────────────

test('validateTarget rejects null/undefined target', async () => {
    const { validateTarget } = await import('../../src/messaging/send.js');
    assert.equal(validateTarget(null as any, 'discord'), false);
    assert.equal(validateTarget(undefined as any, 'discord'), false);
});

test('validateTarget rejects empty targetId', async () => {
    const { validateTarget } = await import('../../src/messaging/send.js');
    assert.equal(validateTarget({ channel: 'discord', targetId: '', targetKind: 'channel', peerKind: 'channel' }, 'discord'), false);
});

test('validateTarget rejects channel mismatch', async () => {
    const { validateTarget } = await import('../../src/messaging/send.js');
    const target = { channel: 'telegram' as const, targetId: '123', targetKind: 'user' as const, peerKind: 'direct' as const };
    assert.equal(validateTarget(target, 'discord'), false);
});

test('validateTarget accepts matching channel with valid targetId', async () => {
    const { validateTarget } = await import('../../src/messaging/send.js');
    const target = { channel: 'discord' as const, targetId: '123456', targetKind: 'channel' as const, peerKind: 'channel' as const };
    // When no channelIds configured (empty), all targets pass
    assert.equal(validateTarget(target, 'discord'), true);
});

test('sendChannelOutput rejects explicit chatId when allowlist is empty', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { registerSendTransport, sendChannelOutput } = await import('../../src/messaging/send.js');
    const previousDiscord = settings.discord;
    try {
        settings.discord = { ...(settings.discord || {}), channelIds: [] };
        registerSendTransport('discord', async () => ({ ok: true }));
        const result = await sendChannelOutput({
            channel: 'discord',
            type: 'text',
            text: 'hello',
            chatId: '123456',
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
    } finally {
        settings.discord = previousDiscord;
    }
});

test('sendChannelOutput allows explicit chatId only when configured', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { registerSendTransport, sendChannelOutput } = await import('../../src/messaging/send.js');
    const previousDiscord = settings.discord;
    try {
        settings.discord = { ...(settings.discord || {}), channelIds: ['123456'] };
        registerSendTransport('discord', async req => ({
            ok: true,
            targetId: req.target?.targetId,
            chatId: req.chatId,
        }));
        const result = await sendChannelOutput({
            channel: 'discord',
            type: 'text',
            text: 'hello',
            chatId: '123456',
        });
        assert.equal(result.ok, true);
        assert.equal(result.targetId, '123456');
    } finally {
        settings.discord = previousDiscord;
    }
});

test('sendChannelOutput rejects disallowed explicit target with 403 status', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { registerSendTransport, sendChannelOutput } = await import('../../src/messaging/send.js');
    const previousDiscord = settings.discord;
    try {
        settings.discord = { ...(settings.discord || {}), channelIds: ['allowed-channel'] };
        registerSendTransport('discord', async () => ({ ok: true }));
        const result = await sendChannelOutput({
            channel: 'discord',
            type: 'text',
            text: 'hello',
            target: {
                channel: 'discord',
                targetKind: 'channel',
                peerKind: 'channel',
                targetId: 'not-allowed',
            },
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
    } finally {
        settings.discord = previousDiscord;
    }
});

test('normalizeChannelSendRequest rejects invalid outbound type and channel', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    assert.throws(
        () => normalizeChannelSendRequest({ channel: 'discord', type: 'sticker' }),
        /invalid_outbound_type/,
    );
    assert.throws(
        // 'slack' became a real channel in 260802_slack_channel wp1, so it is no
        // longer a valid stand-in for "unknown channel". Use one that is not.
        () => normalizeChannelSendRequest({ channel: 'signal', type: 'text' }),
        /invalid_channel/,
    );
    assert.throws(
        () => normalizeChannelSendRequest({ channel: false, type: 'text' }),
        /invalid_channel/,
    );
    assert.throws(
        () => normalizeChannelSendRequest({ channel: 'discord', type: false }),
        /invalid_outbound_type/,
    );
});

// ─── validateDiscordFileSize behavior ────────────────

test('validateDiscordFileSize rejects 11 MiB', async () => {
    const { validateDiscordFileSize } = await import('../../src/discord/discord-file.js');
    assert.throws(
        () => validateDiscordFileSize('big.bin', 11 * 1024 * 1024),
        /exceeds Discord 10 MiB/,
    );
});

test('validateDiscordFileSize accepts 5 MiB', async () => {
    const { validateDiscordFileSize } = await import('../../src/discord/discord-file.js');
    assert.doesNotThrow(() => validateDiscordFileSize('ok.bin', 5 * 1024 * 1024));
});

// ─── normalizeChannelSendRequest behavior ────────────

test('normalizeChannelSendRequest maps body fields correctly', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const jawHome = process.env.CLI_JAW_HOME || process.env.JAW_HOME || path.join(os.homedir(), '.cli-jaw');
    const testDir = path.join(jawHome, 'output');
    fs.mkdirSync(testDir, { recursive: true });
    const testPath = path.join(testDir, `send-test-${Date.now()}.png`);
    fs.writeFileSync(testPath, '');
    try {
        const req = normalizeChannelSendRequest({
            channel: 'discord',
            type: 'photo',
            file_path: testPath,
            caption: 'test',
            chat_id: '123',
        });
        assert.equal(req.channel, 'discord');
        assert.equal(req.type, 'photo');
        assert.equal(req.filePath, fs.realpathSync(testPath));
        assert.equal(req.caption, 'test');
        assert.equal(req.chatId, '123');
    } finally {
        try { fs.unlinkSync(testPath); } catch {}
    }
});

test('normalizeChannelSendRequest allows configured projectDir file paths', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const { settings } = await import('../../src/core/config.js');
    const previousProjectDirs = settings["projectDirs"];
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-project-dir-'));
    const testPath = path.join(projectDir, 'image.png');
    try {
        fs.writeFileSync(testPath, '');
        settings["projectDirs"] = [fs.realpathSync.native(projectDir)];
        const req = normalizeChannelSendRequest({
            channel: 'telegram',
            type: 'photo',
            file_path: testPath,
        });
        assert.equal(req.filePath, fs.realpathSync.native(testPath));
    } finally {
        settings["projectDirs"] = previousProjectDirs;
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
});

test('normalizeChannelSendRequest rejects disallowed file paths before send transport', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const { settings } = await import('../../src/core/config.js');
    const previousProjectDirs = settings["projectDirs"];
    const previousWorkingDir = settings["workingDir"];
    const testPath = path.join(os.tmpdir(), `jaw-send-denied-${Date.now()}.txt`);
    try {
        fs.writeFileSync(testPath, 'secret');
        settings["projectDirs"] = [];
        settings["workingDir"] = '';
        assert.throws(() => normalizeChannelSendRequest({
            channel: 'telegram',
            type: 'document',
            file_path: testPath,
        }), /path_not_allowed/);
    } finally {
        settings["projectDirs"] = previousProjectDirs;
        settings["workingDir"] = previousWorkingDir;
        fs.rmSync(testPath, { force: true });
    }
});

test('normalizeChannelSendRequest defaults channel to active', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const req = normalizeChannelSendRequest({ type: 'text', text: 'hello' });
    assert.equal(req.channel, 'active');
});

// ─── chunkDiscordMessage behavior ────────────────────

test('chunkDiscordMessage handles empty string', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    assert.deepEqual(chunkDiscordMessage(''), ['']);
});

test('chunkDiscordMessage handles exactly 2000 chars', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const text = 'x'.repeat(2000);
    const chunks = chunkDiscordMessage(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 2000);
});

test('chunkDiscordMessage splits 4000 chars into 2 chunks', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const text = 'x'.repeat(4000);
    const chunks = chunkDiscordMessage(text);
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every(c => c.length <= 2000));
});
