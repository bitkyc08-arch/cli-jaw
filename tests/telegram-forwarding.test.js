import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramForwarder } from '../src/telegram-forwarder.js';

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
    assert.equal(sent[0].text.startsWith('📡 '), true);
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

    forward('agent_done', { text: '**bold**', origin: 'web' });
    await flush();

    assert.equal(sent.length, 2);
    assert.equal(sent[0].opts?.parse_mode, 'HTML');
    assert.equal(sent[1].opts, undefined);
});
