import test from 'node:test';
import assert from 'node:assert/strict';
import {
    observeProviderTargets,
    rankTargetCandidates,
} from '../../src/browser/web-ai/observe-targets.ts';

function makeMockPage(cssResults: Record<string, number> = {}) {
    return {
        locator: (selector: string) => ({
            count: async () => cssResults[selector] ?? 0,
            nth: () => ({ isVisible: async () => true }),
        }),
    };
}

test('OBS-TGT-001: rankTargetCandidates sorts by confidence', () => {
    const candidates = [
        { source: 'css', selector: '.a', confidence: 1 },
        { source: 'snapshot-ref', ref: '@e1', role: 'button', confidence: 3 },
        { source: 'css', selector: '.b', confidence: 2 },
    ];
    const ranked = rankTargetCandidates(candidates);
    assert.equal(ranked[0].confidence, 3);
    assert.equal(ranked[1].confidence, 2);
    assert.equal(ranked[2].confidence, 1);
});

test('OBS-TGT-002: rankTargetCandidates boosts expectedRole match', () => {
    const candidates = [
        { source: 'snapshot-ref', ref: '@e1', role: 'button', confidence: 1 },
        { source: 'snapshot-ref', ref: '@e2', role: 'link', confidence: 1 },
    ];
    const ranked = rankTargetCandidates(candidates, { expectedRole: 'button' });
    assert.equal(ranked[0].role, 'button');
    assert.equal(ranked[1].role, 'link');
});

test('OBS-TGT-003: rankTargetCandidates boosts expectedNames match', () => {
    const candidates = [
        { source: 'snapshot-ref', ref: '@e1', role: 'button', name: 'Cancel', confidence: 1 },
        { source: 'snapshot-ref', ref: '@e2', role: 'button', name: 'Submit', confidence: 1 },
    ];
    const ranked = rankTargetCandidates(candidates, { expectedNames: [/Submit/] });
    assert.equal(ranked[0].name, 'Submit');
    assert.equal(ranked[1].name, 'Cancel');
});

test('OBS-TGT-004: rankTargetCandidates boosts snapshot-ref source', () => {
    const candidates = [
        { source: 'css', selector: '.a', confidence: 2 },
        { source: 'snapshot-ref', ref: '@e1', role: 'button', confidence: 2 },
    ];
    const ranked = rankTargetCandidates(candidates);
    assert.equal(ranked[0].source, 'snapshot-ref');
    assert.equal(ranked[1].source, 'css');
});

test('OBS-TGT-005: observeProviderTargets uses snapshot refs', async () => {
    const page = makeMockPage();
    const snapshot = {
        refs: {
            '@e1': { ref: '@e1', role: 'button', name: 'Submit' },
            '@e2': { ref: '@e2', role: 'link', name: 'Cancel' },
        },
    };
    const results = await observeProviderTargets(page as any, {
        featureMap: {
            semanticTargets: {
                submitButton: { roles: ['button'], names: [/Submit/] },
            },
        },
        snapshot,
    });
    assert.ok(results.submitButton);
    assert.equal(results.submitButton.length, 1);
    assert.equal(results.submitButton[0].ref, '@e1');
    assert.equal(results.submitButton[0].source, 'snapshot-ref');
});

test('OBS-TGT-006: observeProviderTargets falls back to CSS selectors', async () => {
    const page = makeMockPage({ '.btn-primary': 1 });
    const results = await observeProviderTargets(page as any, {
        featureMap: {
            semanticTargets: {
                primaryBtn: { cssFallbacks: ['.btn-primary'] },
            },
        },
    });
    assert.ok(results.primaryBtn);
    assert.equal(results.primaryBtn.length, 1);
    assert.equal(results.primaryBtn[0].source, 'css');
    assert.equal(results.primaryBtn[0].selector, '.btn-primary');
    assert.equal(results.primaryBtn[0].confidence, 2);
});

test('OBS-TGT-007: observeProviderTargets filters by role', async () => {
    const page = makeMockPage();
    const snapshot = {
        refs: {
            '@e1': { ref: '@e1', role: 'button', name: 'Submit' },
            '@e2': { ref: '@e2', role: 'link', name: 'Submit' },
        },
    };
    const results = await observeProviderTargets(page as any, {
        featureMap: {
            semanticTargets: {
                submitButton: { roles: ['button'], names: [/Submit/] },
            },
        },
        snapshot,
    });
    assert.equal(results.submitButton.length, 1);
    assert.equal(results.submitButton[0].role, 'button');
});

test('OBS-TGT-008: observeProviderTargets filters by excludeNames', async () => {
    const page = makeMockPage();
    const snapshot = {
        refs: {
            '@e1': { ref: '@e1', role: 'button', name: 'Submit' },
            '@e2': { ref: '@e2', role: 'button', name: 'Cancel' },
        },
    };
    const results = await observeProviderTargets(page as any, {
        featureMap: {
            semanticTargets: {
                submitButton: { roles: ['button'], excludeNames: [/Cancel/] },
            },
        },
        snapshot,
    });
    assert.equal(results.submitButton.length, 1);
    assert.equal(results.submitButton[0].name, 'Submit');
});

test('OBS-TGT-009: observeProviderTargets handles empty results', async () => {
    const page = makeMockPage();
    const results = await observeProviderTargets(page as any, {
        featureMap: {
            semanticTargets: {
                nothing: { roles: ['nonexistent'] },
            },
        },
    });
    assert.deepEqual(results.nothing, []);
});

test('OBS-TGT-010: observeProviderTargets ignores provider argument', async () => {
    const page = makeMockPage();
    const results = await observeProviderTargets(page as any, { provider: 'chatgpt' });
    assert.deepEqual(results, {});
});
