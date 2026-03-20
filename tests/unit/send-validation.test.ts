// Send validation behavior tests — Phase 9
import test from 'node:test';
import assert from 'node:assert/strict';

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
    const req = normalizeChannelSendRequest({
        channel: 'discord',
        type: 'photo',
        file_path: '/tmp/test.png',
        caption: 'test',
        chat_id: '123',
    });
    assert.equal(req.channel, 'discord');
    assert.equal(req.type, 'photo');
    assert.equal(req.filePath, '/tmp/test.png');
    assert.equal(req.caption, 'test');
    assert.equal(req.chatId, '123');
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
