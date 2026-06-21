import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseAgyQuotaWindows, normalizeAntigravityUsageSnapshot } from '../../src/routes/quota-agy-reverse.ts';

test('collapseAgyQuotaWindows keeps Gem and Cla families only', () => {
    const windows = collapseAgyQuotaWindows([
        {
            label: 'Gemini 3.1 Pro (Low)',
            modelId: 'gemini-3.1-pro-low',
            remainingPercentage: 0.25,
            resetTime: '2026-05-28T18:00:00.000Z',
        },
        {
            label: 'Gemini 3.5 Flash (High)',
            modelId: 'gemini-3.5-flash-high',
            remainingPercentage: 0.5,
            resetTime: '2026-05-28T17:00:00.000Z',
        },
        {
            label: 'Claude Sonnet 4.6 (Thinking)',
            modelId: 'claude-sonnet-4-6-thinking',
            remainingPercentage: 0.8,
        },
        {
            label: 'GPT-OSS 120B (Medium)',
            modelId: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
            remainingPercentage: 0.4,
            resetTime: '2026-05-28T09:38:01Z',
        },
        {
            label: 'Autocomplete',
            modelId: 'gemini-2.5-flash-002',
            remainingPercentage: 0.5,
            isAutocompleteOnly: true,
        },
    ]);

    assert.deepEqual(windows.map((window) => window.label), ['Gem', 'Cla']);
    assert.equal(windows[0]?.percent, 75);
    assert.equal(windows[1]?.percent, 20);
});

test('collapseAgyQuotaWindows uses first linked model per family', () => {
    const windows = collapseAgyQuotaWindows([
        { label: 'Gemini 3.5 Flash (High)', modelId: 'gemini-flash-high', remainingPercentage: 0.5 },
        { label: 'Gemini 3.1 Pro (Low)', modelId: 'gemini-pro-low', remainingPercentage: 0.1 },
        { label: 'Claude Sonnet 4.6 (Thinking)', modelId: 'claude-sonnet', remainingPercentage: 0.8 },
        { label: 'GPT-OSS 120B (Medium)', modelId: 'gpt-oss', remainingPercentage: 0.2 },
    ]);
    assert.equal(windows[0]?.label, 'Gem');
    assert.equal(windows[0]?.percent, 50);
    assert.equal(windows[1]?.label, 'Cla');
    assert.equal(windows[1]?.percent, 20);
});

test('normalizeAntigravityUsageSnapshot converts remaining percentage to used percent bars', () => {
    const result = normalizeAntigravityUsageSnapshot({
        method: 'google',
        email: 'user@example.com',
        planType: 'Google AI Pro',
        models: [
            {
                label: 'Gemini 3.1 Pro (Low)',
                modelId: 'gemini-3.1-pro-low',
                remainingPercentage: 0.25,
                resetTime: '2026-05-28T18:00:00.000Z',
            },
            {
                label: 'Claude Sonnet 4.6 (Thinking)',
                modelId: 'claude-sonnet-4-6-thinking',
                remainingPercentage: 1,
                isExhausted: false,
            },
            {
                label: 'Autocomplete',
                modelId: 'gemini-2.5-flash-002',
                remainingPercentage: 0.5,
                isAutocompleteOnly: true,
            },
        ],
    });

    assert.equal(result.quotaCapable, true);
    assert.equal(result.quotaSource, 'agy:antigravity-usage:google');
    assert.equal(result.windows?.length, 2);
    assert.deepEqual(result.windows?.map((window) => window.label), ['Gem', 'Cla']);
    assert.equal(result.windows?.[0]?.percent, 75);
    assert.equal(result.windows?.[1]?.percent, 0);
    assert.equal(result.windows?.[0]?.precision, undefined);
    assert.equal(result.windows?.[1]?.precision, undefined);
    assert.equal((result.account as { tier?: string })?.tier, 'Google AI Pro');
});

test('normalizeAntigravityUsageSnapshot marks binary remaining values as availability states', () => {
    const result = normalizeAntigravityUsageSnapshot({
        method: 'google',
        models: [
            {
                label: 'Gemini 3.1 Pro (Low)',
                modelId: 'gemini-3.1-pro-low',
                remainingPercentage: 0,
                isExhausted: false,
            },
            {
                label: 'Claude Sonnet 4.6 (Thinking)',
                modelId: 'claude-sonnet-4-6-thinking',
                remainingPercentage: 1,
                isExhausted: false,
            },
        ],
    });

    assert.deepEqual(result.windows?.map((window) => window.label), ['Gem', 'Cla']);
    assert.equal(result.windows?.[0]?.percent, 100);
    assert.equal(result.windows?.[1]?.percent, 0);
    assert.equal(result.windows?.[0]?.precision, 'binary');
    assert.equal(result.windows?.[0]?.status, 'exhausted');
    assert.equal(result.windows?.[1]?.precision, 'binary');
    assert.equal(result.windows?.[1]?.status, 'available');
});
