import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isProviderUrl,
    shouldNavigateToRequestedProviderUrl,
    waitForPageUrl,
    isProviderPageDriveable,
    type NavReadyPage,
} from '../../src/browser/web-ai/navigation-ready.ts';

// 102 navigation-ready (P1): provider-URL classification + stale-CDP driveability guard.
test('BWAI-NAVREADY-001: isProviderUrl recognizes provider hosts (www-stripped) only', () => {
    assert.equal(isProviderUrl('https://chatgpt.com/c/abc'), true);
    assert.equal(isProviderUrl('https://www.chatgpt.com/'), true);
    assert.equal(isProviderUrl('https://chat.openai.com/'), true);
    assert.equal(isProviderUrl('https://gemini.google.com/app'), true);
    assert.equal(isProviderUrl('https://grok.com/'), true);
    assert.equal(isProviderUrl('https://example.com/'), false);
    assert.equal(isProviderUrl('not a url'), false);
    assert.equal(isProviderUrl(null), false);
});

test('BWAI-NAVREADY-002: shouldNavigate — blank/origin/path/query rules', () => {
    const N = shouldNavigateToRequestedProviderUrl;
    assert.equal(N(null, null), false, 'no requested → no nav');
    assert.equal(N('https://chatgpt.com/c/1', null), false, 'no requested → no nav');
    assert.equal(N('about:blank', 'https://chatgpt.com/c/1'), true, 'blank → nav');
    assert.equal(N('', 'https://chatgpt.com/c/1'), true, 'empty → nav');
    assert.equal(N('https://chatgpt.com/c/1', 'https://chatgpt.com/c/1'), false, 'identical → no nav');
    assert.equal(N('https://chatgpt.com/c/1', 'https://chatgpt.com/c/2'), true, 'path differs → nav');
    assert.equal(N('https://chat.openai.com/c/1', 'https://chatgpt.com/c/1'), true, 'origin differs → nav');
    assert.equal(N('https://chatgpt.com/c/1', 'https://chatgpt.com/c/1?model=gpt-5'), true, 'requested query absent → nav');
    assert.equal(N('https://chatgpt.com/c/1?model=gpt-5', 'https://chatgpt.com/c/1'), false, 'no requested query → no nav');
    assert.equal(N('not a url', 'https://chatgpt.com/c/1'), true, 'malformed → nav (safe)');
});

test('BWAI-NAVREADY-003: waitForPageUrl returns known url without waiting; waits when blank', async () => {
    const ready: NavReadyPage = {
        url: () => 'https://chatgpt.com/c/1',
        locator: () => ({ first() { return this; }, async waitFor() {}, async count() { return 0; } }),
        async waitForTimeout() {},
    };
    assert.equal(await waitForPageUrl(ready), 'https://chatgpt.com/c/1');

    let waited = false;
    let resolvedUrl = '';
    const blank: NavReadyPage = {
        url: () => resolvedUrl,
        locator: () => ({ first() { return this; }, async waitFor() {}, async count() { return 0; } }),
        async waitForTimeout() {},
        async waitForLoadState() { waited = true; resolvedUrl = 'https://chatgpt.com/c/9'; },
    };
    const out = await waitForPageUrl(blank, { timeoutMs: 50 });
    assert.equal(waited, true, 'waited for load state when url was blank');
    assert.equal(out, 'https://chatgpt.com/c/9');
});

test('BWAI-NAVREADY-004: driveable=false when navigation is needed (stale/blank target)', async () => {
    const page: NavReadyPage = {
        url: () => 'about:blank',
        locator: () => ({ first() { return this; }, async waitFor() {}, async count() { return 0; } }),
        async waitForTimeout() {},
        async title() { return 'should not be reached'; },
    };
    assert.equal(await isProviderPageDriveable(page, 'https://chatgpt.com/c/1'), false);
});

test('BWAI-NAVREADY-005: driveable=true when url matches and title() resolves', async () => {
    const page: NavReadyPage = {
        url: () => 'https://chatgpt.com/c/1',
        locator: () => ({ first() { return this; }, async waitFor() {}, async count() { return 0; } }),
        async waitForTimeout() {},
        async title() { return 'ChatGPT'; },
    };
    assert.equal(await isProviderPageDriveable(page, 'https://chatgpt.com/c/1'), true);
});

test('BWAI-NAVREADY-006: driveable=false when title() hangs past the probe timeout', async () => {
    const page: NavReadyPage = {
        url: () => 'https://chatgpt.com/c/1',
        locator: () => ({ first() { return this; }, async waitFor() {}, async count() { return 0; } }),
        async waitForTimeout() {},
        title: () => new Promise<string>(() => { /* never resolves — wedged target */ }),
    };
    assert.equal(await isProviderPageDriveable(page, 'https://chatgpt.com/c/1', { probeTimeoutMs: 20 }), false);
});
