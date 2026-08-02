import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addBroadcastListener, broadcast, removeBroadcastListener } from '../src/core/bus.ts';
import { drainLogRing } from '../src/core/logger.ts';
import {
    chunkTelegramMessage,
    createForwarderLifecycle,
    createTelegramForwarder,
    escapeHtmlTg,
    markdownToTelegramHtml,
} from '../src/telegram/forwarder.ts';

function createBotSpy({ failHtmlOnce = false } = {}) {
    const sent = [];
    const photos = [];
    const events = [];
    let resolvePhoto!: () => void;
    const photoSent = new Promise<void>((resolve) => { resolvePhoto = resolve; });
    let failed = false;
    return {
        sent,
        photos,
        events,
        photoSent,
        bot: {
            api: {
                async sendMessage(chatId, text, opts) {
                    events.push('text');
                    sent.push({ chatId, text, opts });
                    if (failHtmlOnce && !failed && opts?.parse_mode === 'HTML') {
                        failed = true;
                        // The ladder only falls back on a FORMATTING rejection
                        // now: a bare Error could equally be a rate limit or a
                        // network failure, and re-sending those was the defect.
                        throw Object.assign(new Error('unsupported start tag: invalid html'), {
                            error_code: 400,
                        });
                    }
                    return { ok: true };
                },
                async sendPhoto(chatId, file, opts) {
                    events.push('photo');
                    photos.push({ chatId, file, opts });
                    resolvePhoto();
                    return { ok: true };
                },
            },
        },
    };
}

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

test('forwarder skips telegram-origin responses', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        getLastChatId: () => 123,
        shouldSkip: (data) => data.origin === 'telegram',
    });

    forward('agent_done', { text: 'A', origin: 'telegram' });
    forward('agent_done', { text: 'B', origin: 'web' });
    await flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 123);
    assert.equal(sent[0].opts?.parse_mode, 'HTML');
    assert.equal(sent[0].text, '📡 B');
});

test('forwarder skips error responses', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        getLastChatId: () => 123,
    });

    forward('agent_done', { text: 'error text', error: true, origin: 'web' });
    await flush();
    assert.equal(sent.length, 0);
});

test('forwarder sends watchdog stall diagnostics even when marked error', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        getLastChatId: () => 123,
    });

    forward('agent_done', {
        text: '❌ ⏱️ 응답 없음 — unsafe AGY run_command broad home search',
        error: true,
        origin: 'web',
    });
    await flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].text.includes('응답 없음'), true);
    assert.equal(sent[0].text.includes('broad home search'), true);
});

test('forwarder falls back to plain text when HTML send fails', async () => {
    const { bot, sent } = createBotSpy({ failHtmlOnce: true });
    const forward = createTelegramForwarder({
        bot,
        getLastChatId: () => 777,
    });

    forward('agent_done', { text: '**bold** <tag>', origin: 'web' });
    await flush();

    assert.equal(sent.length, 2);
    assert.equal(sent[0].opts?.parse_mode, 'HTML');
    assert.equal(sent[0].text.includes('<b>bold</b>'), true);
    assert.equal(sent[1].opts, undefined);
    assert.equal(sent[1].text.includes('<b>'), false);
    assert.equal(sent[1].text.includes('bold'), true);
});

test('forwarder handles mixed origin/error events deterministically', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        getLastChatId: () => 456,
        shouldSkip: (data) => data.origin === 'telegram',
    });

    forward('agent_done', { text: 'skip telegram', origin: 'telegram' });
    forward('agent_done', { text: 'ok web', origin: 'web' });
    forward('agent_done', { text: 'skip error', origin: 'web', error: true });
    forward('agent_done', { text: 'ok cli', origin: 'cli' });
    await flush();

    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, '📡 ok web');
    assert.equal(sent[1].text, '📡 ok cli');
});

test('forwarder chunks long messages into multiple sends', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        getLastChatId: () => 999,
    });
    const longText = `**head**\n${'x'.repeat(5000)}`;

    forward('agent_done', { text: longText, origin: 'web' });
    await flush();

    assert.equal(sent.length >= 2, true);
    assert.equal(sent.every((msg) => msg.opts?.parse_mode === 'HTML'), true);
    assert.equal(sent.every((msg) => msg.chatId === 999), true);
    assert.equal(sent[0].text.startsWith('📡 '), true);
});

test('forwarder does nothing when type is not agent_done or chatId is missing', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        getLastChatId: () => null,
    });

    forward('agent_tool', { text: 'tool message', origin: 'web' });
    forward('agent_done', { text: 'done', origin: 'web' });
    await flush();

    assert.equal(sent.length, 0);
});

test('image relay activation: agent_done broadcast sends text then sendPhoto', { timeout: 2000 }, async () => {
    assert.ok(process.env["CLI_JAW_HOME"], 'tests/run.mts must provide isolated CLI_JAW_HOME');
    const uploadDir = path.join(process.env["CLI_JAW_HOME"]!, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, 'relay-activation.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { bot, photos, events, photoSent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        getLastChatId: () => 123,
        getLastTarget: () => ({
            channel: 'telegram',
            targetKind: 'channel',
            peerKind: 'group',
            targetId: '123',
            threadId: '42',
        }),
    });
    addBroadcastListener(forward);
    try {
        broadcast('agent_done', {
            origin: 'web',
            text: `ready\n![generated](${imagePath})`,
        });
        await photoSent;
        assert.deepEqual(events, ['text', 'photo']);
        assert.equal(photos.length, 1);
        assert.equal(photos[0].chatId, '123');
        assert.equal(photos[0].opts?.message_thread_id, 42);
    } finally {
        removeBroadcastListener(forward);
        fs.rmSync(imagePath, { force: true });
    }
});

test('image relay guard skips and logs a path outside allowed roots', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-relay-denied-'));
    const imagePath = path.join(outsideDir, 'denied.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { bot, sent, photos } = createBotSpy();
    const before = drainLogRing().length;
    const forward = createTelegramForwarder({ bot, getLastChatId: () => 123 });
    try {
        const returnValue = forward('agent_done', {
            origin: 'web',
            text: `ready\n![denied](${imagePath})`,
        });
        assert.equal(returnValue, undefined, 'forwarder keeps a synchronous listener signature');
        await flush();
        assert.equal(sent.length, 1, 'text remains available');
        assert.equal(photos.length, 0, 'guarded image is not sent');
        assert.ok(
            drainLogRing().slice(before).some((entry) =>
                entry.level === 'warn' && entry.text.includes('[tg:image-relay] skipped')),
            'guard rejection must leave a warning',
        );
    } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});

test('markdownToTelegramHtml converts markdown while preserving escaped html', () => {
    const html = markdownToTelegramHtml('**B** *I* `C` ~~S~~ <x>');
    assert.equal(html.includes('<b>B</b>'), true);
    assert.equal(html.includes('<i>I</i>'), true);
    assert.equal(html.includes('<code>C</code>'), true);
    assert.equal(html.includes('<s>S</s>'), true);
    assert.equal(html.includes('&lt;x&gt;'), true);
});

test('escapeHtmlTg escapes angle brackets and ampersands', () => {
    assert.equal(escapeHtmlTg('<a&b>'), '&lt;a&amp;b&gt;');
});

test('chunkTelegramMessage splits by newline when possible', () => {
    const input = 'line1\nline2\nline3\nline4';
    const chunks = chunkTelegramMessage(input, 10);
    assert.equal(chunks.length > 1, true);
    assert.equal(chunks.every((chunk) => chunk.length <= 10), true);
    assert.equal(chunks.join(''), input);
});

test('chunkTelegramMessage falls back to hard split without newlines', () => {
    const input = 'abcdefghij';
    const chunks = chunkTelegramMessage(input, 5);
    assert.deepEqual(chunks, ['abcde', 'fghij']);
});

test('createForwarderLifecycle attach/detach is idempotent', () => {
    const added = [];
    const removed = [];
    let buildCount = 0;

    const lifecycle = createForwarderLifecycle({
        addListener: (fn) => added.push(fn),
        removeListener: (fn) => removed.push(fn),
        buildForwarder: () => {
            buildCount += 1;
            return () => { };
        },
    });

    const first = lifecycle.attach({ bot: {} });
    const second = lifecycle.attach({ bot: {} });
    lifecycle.detach();
    lifecycle.detach();

    assert.equal(typeof first, 'function');
    assert.equal(first, second);
    assert.equal(buildCount, 1);
    assert.equal(added.length, 1);
    assert.equal(removed.length, 1);
    assert.equal(lifecycle.getCurrent(), null);
});

test('createForwarderLifecycle can attach again after detach', () => {
    let buildCount = 0;
    const lifecycle = createForwarderLifecycle({
        buildForwarder: () => {
            buildCount += 1;
            return () => { };
        },
    });

    const first = lifecycle.attach();
    lifecycle.detach();
    const second = lifecycle.attach();

    assert.equal(typeof first, 'function');
    assert.equal(typeof second, 'function');
    assert.notEqual(first, second);
    assert.equal(buildCount, 2);
});
