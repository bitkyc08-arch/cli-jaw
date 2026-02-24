import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chunkTelegramMessage,
    createTelegramForwarder,
    escapeHtmlTg,
    markdownToTelegramHtml,
} from '../src/telegram-forwarder.js';

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
