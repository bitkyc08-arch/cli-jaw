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
                        { role: 'button', name: 'Copy' },
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
