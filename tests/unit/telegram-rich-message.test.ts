import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RICH_MESSAGE_LIMIT,
    chunkRichMarkdown,
    sendTelegramMarkdown,
    supportsRichMessage,
} from '../../src/telegram/rich-message.ts';

interface SentRich { chatId: string | number; rich: { markdown?: string; html?: string }; opts?: Record<string, unknown> }
interface SentMsg { chatId: string | number; text: string; opts?: Record<string, unknown> }

function createRichApiSpy({ failRichChunks = 0, failHtml = false } = {}) {
    const richSent: SentRich[] = [];
    const msgSent: SentMsg[] = [];
    let richFailures = 0;
    const api = {
        async sendRichMessage(chatId: string | number, rich: { markdown?: string }, opts?: Record<string, unknown>) {
            if (richFailures < failRichChunks) {
                richFailures += 1;
                throw new Error('rich rejected');
            }
            richSent.push({ chatId, rich, opts });
            return { ok: true };
        },
        async sendMessage(chatId: string | number, text: string, opts?: Record<string, unknown>) {
            if (failHtml && opts?.["parse_mode"] === 'HTML') throw new Error('invalid html');
            msgSent.push({ chatId, text, opts });
            return { ok: true };
        },
    };
    return { api: api as never, richSent, msgSent };
}

function createHtmlOnlyApiSpy() {
    const msgSent: SentMsg[] = [];
    const api = {
        async sendMessage(chatId: string | number, text: string, opts?: Record<string, unknown>) {
            msgSent.push({ chatId, text, opts });
            return { ok: true };
        },
    };
    return { api: api as never, msgSent };
}

test('rich-capable api sends raw markdown via sendRichMessage only', async () => {
    const { api, richSent, msgSent } = createRichApiSpy();
    await sendTelegramMarkdown(api, 123, '# Title\n\n**bold** and a | table |', { message_thread_id: 7 });

    assert.equal(richSent.length, 1);
    assert.equal(msgSent.length, 0);
    assert.equal(richSent[0].rich.markdown, '# Title\n\n**bold** and a | table |');
    assert.deepEqual(richSent[0].opts, { message_thread_id: 7 });
});

test('rich chunk failure falls back to HTML for that chunk only', async () => {
    const { api, richSent, msgSent } = createRichApiSpy({ failRichChunks: 1 });
    await sendTelegramMarkdown(api, 5, '**hello**');

    assert.equal(richSent.length, 0);
    assert.equal(msgSent.length, 1);
    assert.equal(msgSent[0].text, '<b>hello</b>');
    assert.equal(msgSent[0].opts?.["parse_mode"], 'HTML');
});

test('HTML failure falls back to plaintext with legacy opts shape', async () => {
    const { api, msgSent } = createRichApiSpy({ failRichChunks: 99, failHtml: true });
    await sendTelegramMarkdown(api, 5, '**hello**');

    assert.equal(msgSent.length, 1);
    assert.equal(msgSent[0].text, 'hello');
    // Legacy wire shape: no options object at all when nothing to send.
    assert.equal(msgSent[0].opts, undefined);
});

test('api without sendRichMessage takes the HTML chain', async () => {
    const { api, msgSent } = createHtmlOnlyApiSpy();
    assert.equal(supportsRichMessage(api), false);
    await sendTelegramMarkdown(api, 9, '**bold**', { message_thread_id: 3 });

    assert.equal(msgSent.length, 1);
    assert.equal(msgSent[0].text, '<b>bold</b>');
    assert.deepEqual(msgSent[0].opts, { parse_mode: 'HTML', message_thread_id: 3 });
});

test('prefix attaches to first chunk only across rich chunks', async () => {
    const { api, richSent } = createRichApiSpy();
    const para = 'x'.repeat(20000);
    await sendTelegramMarkdown(api, 1, `${para}\n\n${para}`, { prefix: '📡 ' });

    assert.equal(richSent.length, 2);
    assert.ok(richSent[0].rich.markdown!.startsWith('📡 '));
    assert.equal(richSent[1].rich.markdown!.startsWith('📡 '), false);
});

test('chunkRichMarkdown splits at paragraph boundaries under the rich limit', () => {
    const para = 'y'.repeat(20000);
    const md = `${para}\n\n${para}`;
    const chunks = chunkRichMarkdown(md);

    assert.equal(chunks.join(''), md);
    assert.equal(chunks.length, 2);
    for (const c of chunks) assert.ok(c.length <= RICH_MESSAGE_LIMIT);
});

test('chunkRichMarkdown does not split inside a code fence', () => {
    const before = 'a'.repeat(25000);
    const fenceBody = 'code line\n'.repeat(1500);
    const md = `${before}\n\n\`\`\`ts\n${fenceBody}\`\`\`\n\ntail`;
    const chunks = chunkRichMarkdown(md);

    assert.equal(chunks.join(''), md);
    for (const c of chunks) {
        const fences = (c.match(/```/g) || []).length;
        assert.equal(fences % 2, 0, `chunk splits a code fence: ...${c.slice(-40)}`);
    }
});

test('business_connection_id and direct_messages_topic_id propagate to rich sends', async () => {
    const { api, richSent } = createRichApiSpy();
    await sendTelegramMarkdown(api, 2, 'hi', {
        business_connection_id: 'biz1',
        direct_messages_topic_id: 42,
    });

    assert.deepEqual(richSent[0].opts, { business_connection_id: 'biz1', direct_messages_topic_id: 42 });
});
