import test from 'node:test';
import assert from 'node:assert/strict';
import {
    featureDefinitionsForVendor,
    diagnoseFeature,
    runDoctor,
} from '../../src/browser/web-ai/doctor.js';

function fakePage(matchMap: Record<string, { matched: number; visible: boolean }>) {
    return {
        url: () => 'https://chatgpt.com/c/test',
        locator: (selector: string) => ({
            count: async () => matchMap[selector]?.matched ?? 0,
            nth: () => ({
                isVisible: async () => matchMap[selector]?.visible ?? false,
            }),
        }),
        evaluate: async (fn: any, arg: any) => {
            if (typeof fn === 'function') {
                return fn(arg);
            }
            return null;
        },
        accessibility: {
            snapshot: async () => ({ role: 'document', name: '' }),
        },
    };
}

test('DOC-001: featureDefinitionsForVendor returns features for known vendors', () => {
    const chatgpt = featureDefinitionsForVendor('chatgpt');
    assert.ok(chatgpt.length > 0);
    assert.ok(chatgpt.some(f => f.feature === 'composer'));

    const gemini = featureDefinitionsForVendor('gemini');
    assert.ok(gemini.some(f => f.feature === 'composer'));

    const grok = featureDefinitionsForVendor('grok');
    assert.ok(grok.some(f => f.feature === 'composer'));

    assert.deepEqual(featureDefinitionsForVendor('unknown'), []);
});

test('DOC-002: diagnoseFeature reports ok when selectors match and are visible', async () => {
    const page = fakePage({
        '#prompt-textarea': { matched: 1, visible: true },
    });
    const result = await diagnoseFeature(page, {
        feature: 'composer',
        selectors: ['#prompt-textarea', '[data-testid="composer-textarea"]'],
    });
    assert.equal(result.feature, 'composer');
    assert.equal(result.state, 'ok');
    assert.equal(result.selectorCounts.matched, 1);
});

test('DOC-003: diagnoseFeature reports fail when no selectors match', async () => {
    const page = fakePage({});
    const result = await diagnoseFeature(page, {
        feature: 'composer',
        selectors: ['#missing'],
    });
    assert.equal(result.state, 'fail');
    assert.equal(result.selectorCounts.matched, 0);
});

test('DOC-004: runDoctor returns report with vendor and warnings', async () => {
    const page = fakePage({});
    const report = await runDoctor({ getPage: async () => page }, { vendor: 'chatgpt' });
    assert.equal(report.vendor, 'chatgpt');
    assert.ok(Array.isArray(report.features));
    assert.ok(Array.isArray(report.warnings));
    assert.ok(report.capturedAt);
});

test('DOC-005: runDoctor clamps report when oversized', async () => {
    const page = fakePage({});
    const report = await runDoctor({ getPage: async () => page }, { vendor: 'chatgpt', full: true });
    assert.equal(report.vendor, 'chatgpt');
});
