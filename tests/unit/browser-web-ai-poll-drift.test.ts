import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { captureAssistantResponse } from '../../src/browser/web-ai/chatgpt-response.js';

// timeoutMs=1000 keeps the early-wake observer disabled (budget must exceed 1000ms to arm), so the
// driftCheck stub fires on the very first tick without needing a DOM-faithful page mock.
function stubPage(): Page {
    return {
        evaluate: async () => [],
        locator: () => ({ all: async () => [], count: async () => 0, first: () => ({ count: async () => 0 }) }),
        waitForTimeout: async () => undefined,
        url: () => 'https://chatgpt.com/c/AAA',
    } as unknown as Page;
}

// 104.18: a per-tick conversation drift aborts the poll with a typed conversation-mismatch result.
test('BWAI-POLL-DRIFT-001: driftCheck reason aborts the poll as conversation-mismatch', async () => {
    const result = await captureAssistantResponse(stubPage(), {
        minTurnIndex: 0,
        timeoutMs: 1000,
        driftCheck: async () => 'conversation changed: AAA → BBB',
    });
    assert.equal(result.ok, false);
    assert.equal(result.drift?.status, 'conversation-mismatch');
    assert.equal(result.drift?.reason, 'conversation changed: AAA → BBB');
    assert.ok(result.warnings.some(w => w.includes('conversation-drift')));
});

// 104.18: a page-death thrown mid-tick is caught and surfaced as a recoverable tab-crashed result.
test('BWAI-POLL-DRIFT-002: page-death mid-poll surfaces a recoverable tab-crashed', async () => {
    const result = await captureAssistantResponse(stubPage(), {
        minTurnIndex: 0,
        timeoutMs: 1000,
        driftCheck: async () => { throw new Error('Target closed'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.drift?.status, 'tab-crashed');
    assert.equal(result.drift?.recoverable, true);
    assert.ok(result.warnings.includes('tab-crashed-during-poll'));
});

// 104.18: a non-page-death error still propagates — it is NOT masked as a crash.
test('BWAI-POLL-DRIFT-003: non-crash errors propagate instead of masking as tab-crashed', async () => {
    await assert.rejects(
        captureAssistantResponse(stubPage(), {
            minTurnIndex: 0,
            timeoutMs: 1000,
            driftCheck: async () => { throw new Error('some other failure'); },
        }),
        /some other failure/,
    );
});
