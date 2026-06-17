import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    normalizeOpenCodeGoUsage,
} from '../../src/routes/quota-opencode-go-api.js';

describe('normalizeOpenCodeGoUsage', () => {
    test('parses issue #31084 rolling5h schema', () => {
        const result = normalizeOpenCodeGoUsage({
            rolling5h: { usagePercent: 19.5, limitDollars: 12, usedDollars: 2.34, resetInSec: 7200 },
            weekly: { usagePercent: 29.7, limitDollars: 30, usedDollars: 8.91, resetInSec: 345600 },
            monthly: { usagePercent: 25, limitDollars: 60, usedDollars: 15, resetInSec: 1414800 },
            subscribedAt: '2026-05-22T14:30:00Z',
        });
        assert.equal(result.quotaCapable, true);
        assert.equal(result.quotaSource, 'opencode-go:usage-api');
        const windows = result.windows as Array<{ label: string; percent: number }>;
        assert.equal(windows.length, 3);
        assert.equal(windows[0]?.label, '5h');
        assert.equal(windows[0]?.percent, 20);
        assert.equal(windows[1]?.label, 'Weekly');
        assert.equal(windows[2]?.label, 'Monthly');
    });

    test('parses issue #16017 windows schema', () => {
        const result = normalizeOpenCodeGoUsage({
            plan: 'go',
            windows: {
                rolling: { usage_percent: 65, resets_in_seconds: 2520 },
                weekly: { usage_percent: 30, resets_in_seconds: 259200 },
                monthly: { usage_percent: 12, resets_in_seconds: 1728000 },
            },
        });
        assert.equal(result.quotaCapable, true);
        const windows = result.windows as Array<{ label: string; percent: number }>;
        assert.equal(windows[0]?.percent, 65);
        assert.equal(windows[1]?.percent, 30);
        assert.equal(windows[2]?.percent, 12);
    });

    test('invalid payload returns parse error', () => {
        const result = normalizeOpenCodeGoUsage('not-json');
        assert.equal(result.error, true);
        assert.equal(result.reason, 'usage_parse_failed');
    });
});
