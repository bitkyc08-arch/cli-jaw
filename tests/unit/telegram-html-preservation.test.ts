import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToTelegramHtml, chunkTelegramHtmlMessage } from '../../src/telegram/forwarder.ts';

const SUPPORTED_TAG_RE = /<\/?([a-z]+)>/gi;
const SUPPORTED = new Set(['pre', 'code', 'b', 'i', 's']);

function tagBalance(chunk: string): number {
    let balance = 0;
    let match: RegExpExecArray | null;
    while ((match = SUPPORTED_TAG_RE.exec(chunk)) !== null) {
        const tag = match[1].toLowerCase();
        if (!SUPPORTED.has(tag)) continue;
        balance += match[0].startsWith('</') ? -1 : 1;
    }
    return balance;
}

test('Telegram HTML converter preserves supported markdown tags', () => {
    const html = markdownToTelegramHtml('**bold** *italic* `code` ~~strike~~\n```ts\nconst x = 1;\n```');
    assert.ok(html.includes('<b>bold</b>'));
    assert.ok(html.includes('<i>italic</i>'));
    assert.ok(html.includes('<code>code</code>'));
    assert.ok(html.includes('<s>strike</s>'));
    assert.ok(html.includes('<pre><code>const x = 1;\n</code></pre>'));
});

test('Telegram HTML converter escapes unsafe raw HTML before markdown mapping', () => {
    const html = markdownToTelegramHtml('<script>alert(1)</script> **safe**');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('<b>safe</b>'));
    assert.equal(html.includes('<script>'), false);
});

test('chunkTelegramHtmlMessage avoids splitting inside tag tokens', () => {
    const html = '<b>alpha beta gamma</b>\n<i>delta epsilon</i>';
    const chunks = chunkTelegramHtmlMessage(html, 3);
    assert.equal(chunks.join(''), html);
    for (const chunk of chunks) {
        assert.equal((chunk.match(/</g) || []).length, (chunk.match(/>/g) || []).length);
    }
});

test('chunkTelegramHtmlMessage preserves supported tag balance per chunk when possible', () => {
    const html = '<b>alpha beta</b>\n<i>gamma delta</i>\n<s>epsilon zeta</s>';
    const chunks = chunkTelegramHtmlMessage(html, 26);
    assert.equal(chunks.join(''), html);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
        assert.equal(tagBalance(chunk), 0, `unbalanced chunk: ${chunk}`);
        assert.ok(chunk.length <= 26);
    }
});
