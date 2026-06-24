import test from 'node:test';
import assert from 'node:assert/strict';
import { getFetchBrowserPage, releaseFetchBrowserPage, drainPool, getPoolSize } from '../../src/browser/adaptive-fetch/browser-runtime.js';

test('browser pool warm hit reuses released page', async () => {
    let createCount = 0;
    const mockDeps = {
        createIsolatedPage: async () => {
            createCount++;
            const id = createCount;
            return { page: { id }, cleanup: async () => undefined, isolated: true };
        },
    };

    const page1 = await getFetchBrowserPage({ browserDeps: mockDeps, browserSession: 'isolated' });
    assert.equal(createCount, 1);
    await releaseFetchBrowserPage(page1);
    assert.equal(getPoolSize(), 1);

    const page2 = await getFetchBrowserPage({ browserDeps: mockDeps, browserSession: 'isolated' });
    assert.equal(createCount, 1, 'should reuse warm page, not create new');
    assert.equal(getPoolSize(), 0, 'warm page removed from pool on checkout');

    await releaseFetchBrowserPage(page2);
    await drainPool();
    assert.equal(getPoolSize(), 0);
});

test('drainPool empties all warm pages', async () => {
    const mockDeps = {
        createIsolatedPage: async () => ({ page: {}, cleanup: async () => undefined, isolated: true }),
    };

    const p1 = await getFetchBrowserPage({ browserDeps: mockDeps, browserSession: 'isolated' });
    const p2 = await getFetchBrowserPage({ browserDeps: mockDeps, browserSession: 'isolated' });
    await releaseFetchBrowserPage(p1);
    await releaseFetchBrowserPage(p2);
    assert.equal(getPoolSize(), 2);

    await drainPool();
    assert.equal(getPoolSize(), 0);
});
