// Cycle 6 (parity2 060): send-flow fail-closed gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendButtonTimeoutMs } from '../../src/browser/web-ai/chatgpt-attachments.ts';
import { computeAttachmentTimeouts, CDP_INJECTION_THRESHOLD_BYTES } from '../../src/browser/web-ai/chatgpt-upload-surface.ts';
import { submitPromptFromComposer } from '../../src/browser/web-ai/chatgpt-composer.ts';

test('C6-SUBMIT-1: requireEnabledSendButton refuses Enter fallback with typed sentinel', async () => {
    const page = {
        evaluate: async () => false,
        locator: () => ({
            first: () => ({ isVisible: async () => false, isEnabled: async () => false, click: async () => undefined, evaluate: async () => null }),
            count: async () => 0,
            all: async () => [],
        }),
        getByRole: () => ({ count: async () => 0 }),
        keyboard: { press: async () => { throw new Error('Enter must not be pressed with attachments pending'); } },
        waitForTimeout: async () => undefined,
    };
    const result = await submitPromptFromComposer(page as never, { requireEnabledSendButton: true, sendButtonTimeoutMs: 200 });
    assert.equal(result.method, 'none');
    assert.equal(result.failure, 'send-button-disabled');
});

test('C6-SUBMIT-2: without the gate, Enter fallback still works', async () => {
    let enterPressed = false;
    const page = {
        evaluate: async () => false,
        locator: () => ({
            first: () => ({ isVisible: async () => false, isEnabled: async () => false, click: async () => undefined, evaluate: async () => null }),
            count: async () => 0,
            all: async () => [],
        }),
        getByRole: () => ({ count: async () => 0 }),
        keyboard: { press: async () => { enterPressed = true; } },
        waitForTimeout: async () => undefined,
    };
    const result = await submitPromptFromComposer(page as never, { sendButtonTimeoutMs: 200 });
    assert.equal(result.method, 'enter');
    assert.equal(enterPressed, true);
});

test('C6-BUDGET-1: sendButtonTimeoutMs scales with total bytes', () => {
    assert.equal(sendButtonTimeoutMs([]), 20_000);
    const small = sendButtonTimeoutMs(['a.txt'], 1024);
    const big = sendButtonTimeoutMs(['a.bin'], 100 * 1024 * 1024);
    assert.ok(small >= 45_000);
    assert.ok(big > small, `big (${big}) must exceed small (${small})`);
});

test('C6-BUDGET-2: computeAttachmentTimeouts scales and respects explicit override', () => {
    const base = computeAttachmentTimeouts([{ sizeBytes: 1024 }]);
    const big = computeAttachmentTimeouts([{ sizeBytes: 200 * 1024 * 1024 }]);
    assert.ok(big.handoffMs > base.handoffMs);
    assert.ok(big.acceptanceMs > base.acceptanceMs);
    assert.ok(big.sendReadyMs > base.sendReadyMs);
    const explicit = computeAttachmentTimeouts([{ sizeBytes: 200 * 1024 * 1024 }], { attachmentUploadTimeoutMs: 12_345 });
    assert.equal(explicit.handoffMs, 12_345);
    assert.ok(CDP_INJECTION_THRESHOLD_BYTES > 40 * 1024 * 1024);
});
