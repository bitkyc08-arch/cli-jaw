import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chunkTelegramMessage,
    createForwarderLifecycle,
    createTelegramForwarder,
    escapeHtmlTg,
    markdownToTelegramHtml,
} from '../src/telegram/forwarder.js';

function createBotSpy({ failHtmlOnce = false } = {}) {
    const sent = [];
    let failed = false;
    return {
        sent,
        bot: {
            api: {
                async sendMessage(chatId, text, opts) {
                    sent.push({ chatId, text, opts });
                    if (failHtmlOnce && !failed && opts?.parse_mode === 'HTML') {
                        failed = true;
                        throw new Error('invalid html');
                    }
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
