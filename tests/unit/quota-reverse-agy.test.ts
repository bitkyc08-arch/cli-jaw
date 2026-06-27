import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collapseAgyQuotaWindows, normalizeAntigravityUsageSnapshot } from '../../src/routes/quota-agy-reverse.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agyQuotaFixtureDir = path.join(__dirname, '../fixtures/agy-quota');

function loadAgyQuotaFixture(name: string): Parameters<typeof normalizeAntigravityUsageSnapshot>[0] {
    return JSON.parse(fs.readFileSync(path.join(agyQuotaFixtureDir, name), 'utf8')) as Parameters<typeof normalizeAntigravityUsageSnapshot>[0];
}

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

test('AGY quota fixture: precise snapshot keeps percentage windows', () => {
    const result = normalizeAntigravityUsageSnapshot(loadAgyQuotaFixture('precise-google-ai-pro.json'));

    assert.equal(result.quotaCapable, true);
    assert.equal(result.quotaSource, 'agy:antigravity-usage:google');
    assert.deepEqual(result.windows?.map((window) => window.label), ['Gem', 'Cla']);
    assert.equal(result.windows?.[0]?.percent, 75);
    assert.equal(result.windows?.[1]?.percent, 20);
    assert.equal(result.windows?.[0]?.precision, undefined);
    assert.equal(result.windows?.[1]?.precision, undefined);
    assert.equal((result.account as { email?: string })?.email, 'redacted@example.invalid');
});

test('AGY quota fixture: binary snapshot is availability-only', () => {
    const result = normalizeAntigravityUsageSnapshot(loadAgyQuotaFixture('binary-available-exhausted.json'));

    assert.equal(result.quotaCapable, true);
    assert.deepEqual(result.windows?.map((window) => ({
        label: window.label,
        percent: window.percent,
        precision: window.precision,
        status: window.status,
    })), [
        { label: 'Gem', percent: 100, precision: 'binary', status: 'exhausted' },
        { label: 'Cla', percent: 0, precision: 'binary', status: 'available' },
    ]);
});

test('AGY quota fixture: missing empty or error-shaped models fail soft', () => {
    for (const name of ['missing-models.json', 'empty-models.json', 'auth-or-upstream-error.json']) {
        const result = normalizeAntigravityUsageSnapshot(loadAgyQuotaFixture(name));
        assert.equal(result.quotaCapable, false, name);
        assert.deepEqual(result.windows, [], name);
    }
});

test('mixed precise/binary snapshot keeps snapshot-wide precise policy', () => {
    const result = normalizeAntigravityUsageSnapshot(loadAgyQuotaFixture('mixed-precise-binary.json'));

    assert.equal(result.quotaCapable, true);
    assert.deepEqual(result.windows?.map((window) => window.label), ['Gem', 'Cla']);
    assert.equal(result.windows?.[0]?.percent, 0);
    assert.equal(result.windows?.[1]?.percent, 58);
    assert.equal(result.windows?.[0]?.precision, undefined);
    assert.equal(result.windows?.[1]?.precision, undefined);
    assert.equal(result.windows?.[0]?.status, undefined);
    assert.equal(result.windows?.[1]?.status, undefined);
});
