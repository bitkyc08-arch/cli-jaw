import test from 'node:test';
import assert from 'node:assert/strict';
import { auditContractAgainstSnapshot } from '../../src/browser/web-ai/contract-audit.ts';

test('contract audit reports no drift when snapshot has one matching chatgpt target per feature', async () => {
    const page = {
        accessibility: {
            async snapshot() {
                return {
                    role: 'document',
                    children: [
                        { role: 'textbox', name: 'Message ChatGPT' },
                        { role: 'button', name: 'GPT-5' },
                        { role: 'button', name: 'Attach file' },
                        { role: 'article', name: 'Assistant response' },
                        { role: 'button', name: 'Copy' },
                        { role: 'button', name: 'Stop' },
                    ],
                };
            },
        },
    };

    const report = await auditContractAgainstSnapshot(page, 'chatgpt');
    assert.equal(report.vendor, 'chatgpt');
    assert.equal(report.driftCount, 0);
    assert.deepEqual(report.errors, []);
});

// 104.21: the shared 7-feature contract excludes a "search" textbox from the composer match.
test('contract audit: a search textbox does not false-satisfy composer (excludeNames)', async () => {
    const page = {
        accessibility: {
            async snapshot() {
                return {
                    role: 'document',
                    children: [
                        { role: 'textbox', name: 'Search' },           // excluded from composer
                        { role: 'textbox', name: 'Message ChatGPT' },  // the real composer
                        { role: 'button', name: 'GPT-5' },
                        { role: 'button', name: 'Attach file' },
                        { role: 'article', name: 'Assistant response' },
                        { role: 'button', name: 'Copy' },
                        { role: 'button', name: 'Stop' },
                    ],
                };
            },
        },
    };
    const report = await auditContractAgainstSnapshot(page, 'chatgpt');
    // composer matches only "Message ChatGPT" (Search excluded) → no composer drift
    assert.equal(report.drifts.some((drift) => drift.feature === 'composer'), false);
});

test('contract audit distinguishes missing and ambiguous semantic targets', async () => {
    const page = {
        accessibility: {
            async snapshot() {
                return {
                    role: 'document',
                    children: [
                        { role: 'textbox', name: 'Message ChatGPT' },
                        { role: 'textbox', name: 'Message ChatGPT duplicate' },
                    ],
                };
            },
        },
    };

    const report = await auditContractAgainstSnapshot(page, 'chatgpt');
    assert.equal(report.warnings.some((drift) => drift.feature === 'composer'), true);
    assert.equal(report.errors.some((drift) => drift.feature === 'copyButton'), true);
});
