import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTabDuration, selectProviderTabsForCleanup, selectTabsForCleanup } from '../../src/browser/tab-lifecycle.ts';
import { cleanupLeasedTabs, listLeases } from '../../src/browser/web-ai/tab-lease-store.ts';
import { JAW_HOME } from '../../src/core/config.ts';

test('browser tab lifecycle parses cleanup duration strings', () => {
    assert.equal(parseTabDuration('500ms'), 500);
    assert.equal(parseTabDuration('2s'), 2000);
    assert.equal(parseTabDuration('3m'), 180000);
    assert.equal(parseTabDuration('1h'), 3600000);
    assert.equal(parseTabDuration('bad'), 1800000);
});

test('browser tab lifecycle selects idle tabs but preserves pinned and active-session tabs', () => {
    const now = 1_000_000;
    const selected = selectTabsForCleanup({
        now,
        idleTimeoutMs: 10_000,
        maxTabs: 10,
        tabs: [
            { tabId: 'idle', targetId: 'idle', index: 1, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: now - 20_000 },
            { tabId: 'active-session', targetId: 'active-session', index: 2, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: now - 20_000 },
            { tabId: 'pinned', targetId: 'pinned', index: 3, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: now - 20_000 },
            { tabId: 'fresh', targetId: 'fresh', index: 4, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: now - 1000 },
        ],
        activeSessionTargetIds: new Set(['active-session']),
        pinnedTargetIds: new Set(['pinned']),
    });

    assert.deepEqual(selected.map(tab => tab.targetId), ['idle']);
    assert.equal(selected[0]?.cleanupReason, 'idle-timeout');
});

test('browser tab lifecycle enforces max-tabs with oldest closeable tabs', () => {
    const selected = selectTabsForCleanup({
        now: 10_000,
        idleTimeoutMs: 60_000,
        maxTabs: 3,
        tabs: [
            { tabId: 'oldest', targetId: 'oldest', index: 1, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 100 },
            { tabId: 'active-session', targetId: 'active-session', index: 2, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 200 },
            { tabId: 'middle', targetId: 'middle', index: 3, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 300 },
            { tabId: 'newest', targetId: 'newest', index: 4, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 400 },
            { tabId: 'pinned', targetId: 'pinned', index: 5, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 50 },
        ],
        activeSessionTargetIds: new Set(['active-session']),
        pinnedTargetIds: new Set(['pinned']),
    });

    assert.deepEqual(selected.map(tab => tab.targetId), ['oldest', 'middle']);
    assert.equal(selected.every(tab => tab.cleanupReason === 'max-tabs'), true);
});

test('browser tab lifecycle closes untracked tabs only when explicit', () => {
    const input = {
        now: 10_000,
        idleTimeoutMs: 1000,
        maxTabs: 10,
        tabs: [
            { tabId: 'untracked', targetId: 'untracked', index: 1, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: null },
        ],
    };

    assert.deepEqual(selectTabsForCleanup(input), []);
    assert.deepEqual(selectTabsForCleanup({ ...input, includeUntracked: true }).map(tab => tab.cleanupReason), ['untracked']);
});

test('browser tab lifecycle does not close untracked tabs for max-tabs unless explicit', () => {
    const input = {
        now: 10_000,
        idleTimeoutMs: 1000,
        maxTabs: 1,
        tabs: [
            { tabId: 'untracked', targetId: 'untracked', index: 1, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: null },
            { tabId: 'tracked', targetId: 'tracked', index: 2, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 9000 },
        ],
    };

    assert.deepEqual(selectTabsForCleanup(input).map(tab => tab.targetId), ['tracked']);
    assert.deepEqual(selectTabsForCleanup({ ...input, includeUntracked: true }).map(tab => tab.targetId), ['untracked']);
});

test('browser tab lifecycle selects inactive provider overflow tabs only', () => {
    const selected = selectProviderTabsForCleanup({
        provider: 'chatgpt',
        keep: 1,
        activeSessionTargetIds: new Set(['active-session']),
        pinnedTargetIds: new Set(['pinned']),
        tabs: [
            { tabId: 'newest', targetId: 'newest', index: 1, title: '', url: 'https://chatgpt.com/c/newest', type: 'page', active: false, attached: true, lastActiveAt: 300 },
            { tabId: 'old', targetId: 'old', index: 2, title: '', url: 'https://chatgpt.com/c/old', type: 'page', active: false, attached: true, lastActiveAt: 100 },
            { tabId: 'active-session', targetId: 'active-session', index: 3, title: '', url: 'https://chatgpt.com/c/active', type: 'page', active: false, attached: true, lastActiveAt: 50 },
            { tabId: 'pinned', targetId: 'pinned', index: 4, title: '', url: 'https://chatgpt.com/c/pinned', type: 'page', active: false, attached: true, lastActiveAt: 25 },
            { tabId: 'other', targetId: 'other', index: 5, title: '', url: 'https://example.com', type: 'page', active: false, attached: true, lastActiveAt: 1 },
        ],
    });

    assert.deepEqual(selected.map(tab => tab.targetId), ['old']);
    assert.equal(selected[0]?.cleanupReason, 'provider-overflow');
});

test('browser createTab reuses startup about:blank tabs before creating provider tabs', () => {
    const source = readFileSync(new URL('../../src/browser/connection.ts', import.meta.url), 'utf8');
    assert.ok(source.includes('function isReusableBlankTab'));
    assert.ok(source.includes('opts.reuseBlank !== false'));
    assert.ok(source.includes('allTabs.length <= 1'));
    assert.ok(source.includes('reusedBlank: true'));
    assert.ok(source.includes('newBrowserCDPSession'));
    assert.ok(source.includes('createRawBrowserCdpSession'));
    assert.ok(source.includes('createTargetWithWindowFallback'));
});

test('browser tab lifecycle counts only owned closeable leases toward managed max-tabs', () => {
    const now = 10_000;
    const selected = selectTabsForCleanup({
        now,
        idleTimeoutMs: 60_000,
        maxTabs: 1,
        tabs: [
            { tabId: 'user-old', targetId: 'user-old', index: 1, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 100 },
            { tabId: 'owned-old', targetId: 'owned-old', index: 2, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 200 },
            { tabId: 'owned-new', targetId: 'owned-new', index: 3, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 300 },
            { tabId: 'active', targetId: 'active', index: 4, title: '', url: '', type: 'page', active: false, attached: true, lastActiveAt: 50 },
        ],
        activeSessionTargetIds: new Set(['active']),
        leaseByTargetId: new Map([
            ['owned-old', { owner: 'cli-jaw', state: 'pooled' }],
            ['owned-new', { owner: 'cli-jaw', state: 'pooled' }],
            ['active', { owner: 'cli-jaw', state: 'active-session' }],
        ]),
    });

    assert.deepEqual(selected.map(tab => tab.targetId), ['owned-old']);
    assert.equal(selected[0]?.cleanupReason, 'max-tabs');
});

test('browser web-ai tab pool persists leases, locks checkout, and closes evicted tabs', () => {
    const poolSource = readFileSync(new URL('../../src/browser/web-ai/tab-pool.ts', import.meta.url), 'utf8');
    const leaseSource = readFileSync(new URL('../../src/browser/web-ai/tab-lease-store.ts', import.meta.url), 'utf8');
    const finalizerSource = readFileSync(new URL('../../src/browser/web-ai/tab-finalizer.ts', import.meta.url), 'utf8');
    const chatgptSource = readFileSync(new URL('../../src/browser/web-ai/chatgpt.ts', import.meta.url), 'utf8');
    assert.ok(leaseSource.includes('browser-web-ai-tab-leases.json'));
    assert.ok(leaseSource.includes('export async function withLeaseLock'));
    assert.ok(leaseSource.includes('buildLeaseKey'));
    assert.ok(leaseSource.includes('closeTab(port, lease.targetId)'));
    assert.ok(poolSource.includes('releaseCompletedLease'));
    assert.ok(finalizerSource.includes('updateSessionResult'));
    assert.ok(finalizerSource.includes('await poolTab'));
    assert.ok(chatgptSource.includes('cleanupPoolTabs(port)'));
    assert.ok(chatgptSource.includes('getPooledTab(port, vendor'));
    assert.ok(chatgptSource.includes('await finalizeProviderTab'));
});

test('browser web-ai reuses inactive ChatGPT tabs before creating another tab', () => {
    const chatgptSource = readFileSync(new URL('../../src/browser/web-ai/chatgpt.ts', import.meta.url), 'utf8');
    assert.ok(chatgptSource.includes('listTabs'));
    assert.ok(chatgptSource.includes('findReusableChatGptTab'));
    assert.ok(chatgptSource.includes('input.newTab !== true'));
    assert.ok(chatgptSource.includes('const reusable = await findReusableChatGptTab(port)'));
    assert.ok(chatgptSource.includes('await page.goto(vendorUrl'));
});

test('browser tab cleanup API rejects includeUntracked without force', () => {
    const routeSource = readFileSync(new URL('../../src/routes/browser.ts', import.meta.url), 'utf8');
    const cliSource = readFileSync(new URL('../../bin/commands/browser.ts', import.meta.url), 'utf8');
    assert.ok(routeSource.includes('req.body.includeUntracked === true && req.body.force !== true'));
    assert.ok(routeSource.includes('includeUntracked requires force=true'));
    assert.ok(cliSource.includes("values['include-untracked'] === true && values.force !== true"));
    assert.ok(cliSource.includes('tab-cleanup --include-untracked requires --force'));
    assert.ok(cliSource.includes('force: values.force'));
});

test('browser tab cleanup exposes provider overflow UX', () => {
    const lifecycleSource = readFileSync(new URL('../../src/browser/tab-lifecycle.ts', import.meta.url), 'utf8');
    const routeSource = readFileSync(new URL('../../src/routes/browser.ts', import.meta.url), 'utf8');
    const cliSource = readFileSync(new URL('../../bin/commands/browser.ts', import.meta.url), 'utf8');
    assert.ok(lifecycleSource.includes('selectProviderTabsForCleanup'));
    assert.ok(lifecycleSource.includes("cleanupReason: 'provider-overflow'"));
    assert.ok(lifecycleSource.includes('providerClosed'));
    assert.ok(routeSource.includes('provider: req.body.provider'));
    assert.ok(routeSource.includes('keepProviderTabs: req.body.keepProviderTabs'));
    assert.ok(cliSource.includes('provider overflow'));
    assert.ok(cliSource.includes('--keep-provider-tabs 1'));
});

test('browser tab cleanup API runs durable lease pool cleanup', () => {
    const routeSource = readFileSync(new URL('../../src/routes/browser.ts', import.meta.url), 'utf8');
    assert.ok(routeSource.includes("import { cleanupPoolTabs } from '../browser/web-ai/tab-pool.js'"));
    assert.ok(routeSource.includes('const leaseResult = await cleanupPoolTabs(cdpPort(req))'));
    assert.ok(routeSource.includes('leaseClosed'));
    assert.ok(routeSource.includes('leaseClosedTabs'));
});

test('browser web-ai lease cleanup reports actual closed count after close failure', async () => {
    const storePath = join(JAW_HOME, 'browser-web-ai-tab-leases.json');
    mkdirSync(JAW_HOME, { recursive: true });
    writeFileSync(storePath, JSON.stringify({
        version: 1,
        leases: [
            {
                owner: 'cli-jaw',
                vendor: 'chatgpt',
                sessionType: 'jaw',
                origin: 'https://chatgpt.com',
                browserProfileKey: 'cdp:65529',
                targetId: 'close-fails',
                sessionId: 'session-close-fails',
                url: 'https://chatgpt.com/c/close-fails',
                state: 'pooled',
                leasedAt: '2026-05-03T00:00:00.000Z',
                pooledAt: '2026-05-03T00:00:00.000Z',
                finalizedAt: '2026-05-03T00:00:00.000Z',
                poolExpiresAt: '2026-05-03T00:01:00.000Z',
                leaseDisposition: 'pooled',
                updatedAt: '2026-05-03T00:00:00.000Z',
                leaseKey: 'cli-jaw:chatgpt:jaw:https://chatgpt.com:cdp:65529',
            },
        ],
    }));

    const result = await cleanupLeasedTabs(65529);
    const leases = await listLeases();

    assert.equal(result.closed, 0);
    assert.equal(leases.length, 1);
    assert.equal(leases[0]?.state, 'pooled');
    assert.equal(leases[0]?.leaseDisposition, 'close-failed-retryable');
});
