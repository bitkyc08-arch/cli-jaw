import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKiroUsageLimits } from '../../src/routes/quota-kiro-reverse.ts';

test('normalizeKiroUsageLimits maps credit breakdown to quota windows', () => {
    const normalized = normalizeKiroUsageLimits({
        nextDateReset: 1780272000,
        subscriptionInfo: {
            subscriptionTitle: 'KIRO POWER',
            type: 'Q_DEVELOPER_STANDALONE_POWER',
        },
        usageBreakdownList: [
            {
                displayName: 'Credit',
                displayNamePlural: 'Credits',
                currentUsageWithPrecision: 0.41,
                usageLimitWithPrecision: 10000,
                nextDateReset: 1780272000,
                resourceType: 'CREDIT',
            },
        ],
    });

    assert.equal(normalized['quotaCapable'], true);
    assert.equal(normalized['displayTier'], 'Kiro KIRO POWER');
    assert.deepEqual(normalized['windows'], [{
        label: 'Credit',
        percent: 0.0041,
        resetsAt: '2026-06-01T00:00:00.000Z',
    }]);
    assert.equal(normalized['currentUsage'], 0.41);
    assert.equal(normalized['usageLimit'], 10000);
    assert.equal(normalized['reverseEngineered'], true);
});

test('normalizeKiroUsageLimits falls back to limits array', () => {
    const normalized = normalizeKiroUsageLimits({
        limits: [{ type: 'AgenticRequest', currentUsage: 25, totalUsageLimit: 100, percentUsed: 25 }],
    });
    assert.equal(normalized['quotaCapable'], true);
    assert.equal((normalized['windows'] as Array<{ percent: number }>)[0]?.percent, 25);
});
