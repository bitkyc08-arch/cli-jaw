import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { captureAssistantResponse } from '../../src/browser/web-ai/chatgpt-response.js';

// Regression for catalog 101 #9 (the cff76ed false-complete fix): captureAssistantResponse
// must NOT return a completed answer while the page is still streaming. The poll loop never
// stabilizes (stop button stays visible) and the 3rd-tier recovery sees streaming, so the
// result is ok:false — which the watcher treats as keep-polling, not complete.
test('BWAI-STREAM-001: a still-streaming page never yields a completed capture', async () => {
    const fakePage = {
        locator(sel: string) {
            const isStop = /stop-button|Stop/i.test(sel);
            return {
                first: () => ({ isVisible: async () => isStop }), // stop button visible → streaming
                last: () => ({ isVisible: async () => false }),
                count: async () => 0, // no finished-action buttons, no canvas
                all: async () => [],
            };
        },
        // readTopLevelAssistantTexts (function) → a fragment; the observer expr (string) is never
        // built here (budget too small), so any string eval would resolve null.
        evaluate: async (fnOrExpr: unknown) => (typeof fnOrExpr === 'string' ? null : ['streaming fragment text']),
        waitForTimeout: async () => {},
        url: () => 'https://chatgpt.com/c/x',
    };

    const result = await captureAssistantResponse(fakePage as unknown as Page, {
        minTurnIndex: 0,
        timeoutMs: 1,
        allowCopyMarkdownFallback: false,
    });

    assert.equal(result.ok, false, 'must not complete while streaming');
    assert.notEqual(result.answerText, 'streaming fragment text'); // never returns the mid-stream fragment as the answer
});
