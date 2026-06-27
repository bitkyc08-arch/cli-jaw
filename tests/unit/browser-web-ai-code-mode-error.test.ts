import test from 'node:test';
import assert from 'node:assert/strict';
import { codeWebAi, extractCodeArtifacts } from '../../src/browser/web-ai/code-mode.js';
import { WebAiError } from '../../src/browser/web-ai/errors.js';

// 104.16: a non-ChatGPT vendor throws a typed code-mode.vendor-unsupported WebAiError
// (vs a plain Error) — the vendor guard runs before any page/port interaction.
const isVendorUnsupported = (err: unknown): boolean =>
    err instanceof WebAiError && err.errorCode === 'code-mode.vendor-unsupported';

test('BWAI-CODEMODE-001: code + code-extract reject non-chatgpt vendor with a typed error', async () => {
    await assert.rejects(() => codeWebAi(9222, { vendor: 'gemini', prompt: 'x' } as never), isVendorUnsupported);
    await assert.rejects(() => extractCodeArtifacts(9222, { vendor: 'grok' } as never), isVendorUnsupported);
});
