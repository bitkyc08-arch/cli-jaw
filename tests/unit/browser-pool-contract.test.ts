import test from 'node:test';
import assert from 'node:assert/strict';
import { getFetchBrowserPage, releaseFetchBrowserPage, drainPool, getPoolSize } from '../../src/browser/adaptive-fetch/browser-runtime.js';

test('isolated pages are always freshly created (no pooling)', async () => {
    let createCount = 0;
    let cleanupCount = 0;
    const mockDeps = {
        createIsolatedPage: async () => {
            createCount++;
            return { page: { id: createCount }, cleanup: async () => { cleanupCount++; }, isolated: true };
        },
    };

    const page1 = await getFetchBrowserPage({ browserDeps: mockDeps, browserSession: 'isolated' });
    assert.equal(createCount, 1);
    await releaseFetchBrowserPage(page1);
    assert.equal(cleanupCount, 1, 'isolated page cleaned up on release');
    assert.equal(getPoolSize(), 0, 'pool is always empty');

    const page2 = await getFetchBrowserPage({ browserDeps: mockDeps, browserSession: 'isolated' });
    assert.equal(createCount, 2, 'always creates fresh page');
    await releaseFetchBrowserPage(page2);
    assert.equal(cleanupCount, 2);
});

test('drainPool is a safe no-op', async () => {
    await drainPool();
    assert.equal(getPoolSize(), 0);
});

test('existing session pages are not cleaned up by release', async () => {
    let cleanupCalled = false;
    const mockDeps = {
        getPage: async () => ({ id: 'user-page' }),
    };

    const page = await getFetchBrowserPage({ browserDeps: mockDeps, browserSession: 'existing' });
    assert.equal(page.isolated, false);
    await releaseFetchBrowserPage({ ...page, cleanup: async () => { cleanupCalled = true; } });
    assert.equal(cleanupCalled, true, 'cleanup is always called');
});
