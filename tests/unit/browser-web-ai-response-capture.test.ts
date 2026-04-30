import test from 'node:test';
import assert from 'node:assert/strict';
import {
    captureAssistantResponse,
    isPlaceholderAssistantText,
    normalizeAssistantText,
} from '../../src/browser/web-ai/chatgpt-response.js';

test('RESP-001: placeholders are filtered (typing indicator, empty)', () => {
    assert.equal(isPlaceholderAssistantText(''), true);
    assert.equal(isPlaceholderAssistantText('   '), true);
    assert.equal(isPlaceholderAssistantText('Thinking'), true);
    assert.equal(isPlaceholderAssistantText('Answer now'), true);
});

test('RESP-002: real answers are NOT considered placeholders', () => {
    assert.equal(isPlaceholderAssistantText('Sure, here is the answer: 42.'), false);
    assert.equal(isPlaceholderAssistantText('def hello():\n    return "world"'), false);
});

test('RESP-003: normalizeAssistantText collapses NBSP and trims', () => {
    const text = '\u00a0  hello world  \u00a0';
    assert.equal(normalizeAssistantText(text), 'hello world');
});

test('RESP-004: chatgpt-response source has no Oracle imports and no public evaluate', async () => {
    const fs: any = await import('node:fs');
    const src = fs.readFileSync(new URL('../../src/browser/web-ai/chatgpt-response.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from ['"]@steipete\/oracle/);
    assert.doesNotMatch(src, /from ['"]oracle\//);
});

test('RESP-005: captureAssistantResponse records copy fallback through ActionTranscript', async () => {
    const page = fakeResponsePage({
        assistantTexts: ['old answer', 'dom answer'],
        copyText: 'copied answer',
    });
    const result = await captureAssistantResponse(page, {
        minTurnIndex: 1,
        timeoutMs: 80,
        allowCopyMarkdownFallback: true,
        stableWindowMs: 1,
        pollIntervalMs: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.answerText, 'copied answer');
    assert.deepEqual(result.usedFallbacks, ['copy-markdown']);
});

function fakeResponsePage(input: { assistantTexts: string[]; copyText: string }): any {
    return {
        evaluate: async (fn: any, selectors?: readonly string[]) => {
            const source = String(fn);
            if (source.includes('selectorSet')) return { ok: true, text: input.copyText };
            if (Array.isArray(selectors)) return input.assistantTexts;
            return [];
        },
        waitForTimeout: async () => undefined,
        locator: (selector: string) => ({
            first: () => ({
                isVisible: async () => selector.includes('copy-turn-action-button'),
                click: async () => undefined,
            }),
            all: async () => selector.includes('copy-turn-action-button')
                ? [{ isVisible: async () => true, click: async () => undefined }]
                : [],
        }),
    };
}
