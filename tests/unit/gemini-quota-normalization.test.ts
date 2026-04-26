import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyGeminiQuotaTier,
    normalizeGeminiQuotaBuckets,
} from '../../src/routes/quota.ts';
import { nextMonthFirstResetDate } from '../../lib/quota-copilot.ts';

test('GQN-001: classifies Gemini quota tiers from model ids', () => {
    assert.equal(classifyGeminiQuotaTier('gemini-3-pro-preview'), 'pro');
    assert.equal(classifyGeminiQuotaTier('gemini-3.1-pro-preview'), 'pro');
    assert.equal(classifyGeminiQuotaTier('gemini-3-flash-preview'), 'flash');
    assert.equal(classifyGeminiQuotaTier('gemini-2.5-flash'), 'flash');
    assert.equal(classifyGeminiQuotaTier('gemini-3.1-flash-lite-preview'), 'flash-lite');
    assert.equal(classifyGeminiQuotaTier('unknown-model'), null);
});

test('GQN-002: normalizes Pro and Flash buckets to compact P/F labels', () => {
    const windows = normalizeGeminiQuotaBuckets([
        { modelId: 'gemini-3-flash-preview', remainingFraction: 0.99, resetTime: '2026-04-27T00:38:00.000Z' },
        { modelId: 'gemini-3-pro-preview', remainingFraction: 0.98, resetTime: '2026-04-27T00:27:00.000Z' },
    ]);

    assert.deepEqual(windows, [
        { label: 'F', percent: 1, resetsAt: '2026-04-27T00:38:00.000Z', modelId: 'gemini-3-flash-preview' },
        { label: 'P', percent: 2, resetsAt: '2026-04-27T00:27:00.000Z', modelId: 'gemini-3-pro-preview' },
    ]);
});

test('GQN-003: excludes Flash Lite buckets from v1 output', () => {
    const windows = normalizeGeminiQuotaBuckets([
        { modelId: 'gemini-3.1-flash-lite-preview', remainingFraction: 0.1, resetTime: '2026-04-27T01:07:00.000Z' },
        { modelId: 'gemini-2.5-flash-lite', remainingFraction: 0.2, resetTime: '2026-04-27T01:07:00.000Z' },
    ]);

    assert.deepEqual(windows, []);
});

test('GQN-004: ignores invalid buckets and clamps percent', () => {
    const windows = normalizeGeminiQuotaBuckets([
        { remainingFraction: 0.2, resetTime: 'ignored' },
        { modelId: 'gemini-3-pro-preview', resetTime: 'ignored' },
        { modelId: 'gemini-3-pro-preview', remainingFraction: -0.5 },
        { modelId: 'gemini-3-flash-preview', remainingFraction: 1.5 },
    ]);

    assert.deepEqual(windows, [
        { label: 'F', percent: 0, resetsAt: null, modelId: 'gemini-3-flash-preview' },
        { label: 'P', percent: 100, resetsAt: null, modelId: 'gemini-3-pro-preview' },
    ]);
});

test('GQN-005: duplicate tier keeps highest usage and preserves modelId', () => {
    const windows = normalizeGeminiQuotaBuckets([
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.8, resetTime: 'lower-usage' },
        { modelId: 'gemini-3-pro-preview', remainingFraction: 0.2, resetTime: 'higher-usage' },
        { modelId: 'gemini-2.5-flash', remainingFraction: 0.7, resetTime: 'lower-flash' },
        { modelId: 'gemini-3-flash-preview', remainingFraction: 0.5, resetTime: 'higher-flash' },
    ]);

    assert.deepEqual(windows, [
        { label: 'F', percent: 50, resetsAt: 'higher-flash', modelId: 'gemini-3-flash-preview' },
        { label: 'P', percent: 80, resetsAt: 'higher-usage', modelId: 'gemini-3-pro-preview' },
    ]);
});

test('GQN-006: Copilot monthly fallback uses next month first', () => {
    assert.equal(
        nextMonthFirstResetDate(new Date(2026, 3, 26, 16, 21, 0, 0)),
        new Date(2026, 4, 1, 0, 0, 0, 0).toISOString(),
    );
    assert.equal(
        nextMonthFirstResetDate(new Date(2026, 11, 20, 16, 21, 0, 0)),
        new Date(2027, 0, 1, 0, 0, 0, 0).toISOString(),
    );
});
