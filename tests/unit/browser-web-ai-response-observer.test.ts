import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import {
    buildResponseObserverExpression,
    observeAssistantResponse,
    recoverAssistantResponse,
} from '../../src/browser/web-ai/chatgpt-response-observer.js';

test('BWAI-OBS-001: observer expression embeds clamped bounds + MutationObserver', () => {
    const expr = buildResponseObserverExpression({ baselineAssistantCount: 2, quietMs: 50, timeoutMs: 500 });
    assert.match(expr, /const MIN = 2;/);
    assert.match(expr, /const QUIET = 200;/, 'quietMs clamps up to 200');
    assert.match(expr, /const HARD = 1000;/, 'timeoutMs clamps up to 1000');
    assert.match(expr, /new MutationObserver/);
    assert.match(expr, /stop-button/);
});

test('BWAI-OBS-002: observeAssistantResponse returns settle signal, null on abort', async () => {
    const page = { evaluate: async () => ({ settled: true }) } as unknown as Page;
    assert.deepEqual(await observeAssistantResponse(page, { baselineAssistantCount: 1 }), { settled: true });

    const controller = new AbortController();
    controller.abort();
    assert.equal(await observeAssistantResponse(page, { signal: controller.signal }), null);
});

test('BWAI-OBS-003: recovery filters placeholders and returns the latest final answer', async () => {
    const page = {
        evaluate: async () => ['Pro thinking…', 'REAL FINAL ANSWER'],
        waitForTimeout: async () => {},
    } as unknown as Page;
    const res = await recoverAssistantResponse(page, {
        baselineAssistantCount: 0,
        isFinalAnswer: (t) => t !== 'Pro thinking…',
        readStreaming: () => false,
        readFinished: () => true,
    });
    assert.equal(res?.from, 'recovery');
    assert.equal(res?.text, 'REAL FINAL ANSWER');
    assert.equal(res?.finished, true);
    assert.equal(res?.streaming, false);
});

test('BWAI-OBS-004: recovery reports streaming, and null when nothing passes the filter', async () => {
    const streamingPage = { evaluate: async () => ['answer'], waitForTimeout: async () => {} } as unknown as Page;
    const streamingRes = await recoverAssistantResponse(streamingPage, { isFinalAnswer: () => true, readStreaming: () => true });
    assert.equal(streamingRes?.streaming, true);
    assert.equal(streamingRes?.finished, false);

    const placeholderPage = { evaluate: async () => ['placeholder'], waitForTimeout: async () => {} } as unknown as Page;
    const none = await recoverAssistantResponse(placeholderPage, { isFinalAnswer: (t) => t !== 'placeholder' });
    assert.equal(none, null);
});

test('BWAI-OBS-005: recovery waits a stability window then confirms a stable answer', async () => {
    const page = {
        evaluate: async () => ['STABLE ANSWER'],
        waitForTimeout: async () => {},
    } as unknown as Page;
    const res = await recoverAssistantResponse(page, {
        isFinalAnswer: () => true,
        readStreaming: () => false,
        readFinished: () => false,
        stabilityWindowMs: 10,
    });
    assert.equal(res?.text, 'STABLE ANSWER');
    assert.ok((res?.responseStableMs ?? 0) >= 1, 'a stable re-read records a positive stability window');
});
