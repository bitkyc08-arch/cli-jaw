import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CHATGPT_COPY_SELECTORS,
    GEMINI_COPY_SELECTORS,
    captureCopiedResponseText,
    preferCopiedText,
} from '../../src/browser/web-ai/copy-markdown.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('COPY-MD-001: selector presets include observed ChatGPT and Gemini copy buttons', () => {
    assert.ok(CHATGPT_COPY_SELECTORS.copyButtonSelectors.includes('button[data-testid="copy-turn-action-button"]'));
    assert.ok(GEMINI_COPY_SELECTORS.turnSelectors.includes('model-response'));
    assert.ok(GEMINI_COPY_SELECTORS.copyButtonSelectors.includes('button[data-test-id="copy-button"]'));
});

test('COPY-MD-002: helper intercepts page clipboard writes without OS clipboard read', async () => {
    const page = {
        evaluate: async () => ({ ok: true, text: 'copied **markdown**' }),
    };
    const result = await captureCopiedResponseText(page, CHATGPT_COPY_SELECTORS);
    assert.deepEqual(result, { ok: true, text: 'copied **markdown**' });

    const src = fs.readFileSync(join(root, 'src/browser/web-ai/copy-markdown.ts'), 'utf8');
    assert.match(src, /writeText/);
    assert.match(src, /Object\.defineProperty\(clipboard, 'write'/);
    assert.doesNotMatch(src, /readText\s*\(/);
});

test('COPY-MD-003: copied text is rejected when it is likely truncated', () => {
    assert.equal(preferCopiedText('a'.repeat(200), { ok: true, text: 'short' }), undefined);
    assert.equal(preferCopiedText('dom answer', { ok: true, text: 'copied answer' }), 'copied answer');
});
