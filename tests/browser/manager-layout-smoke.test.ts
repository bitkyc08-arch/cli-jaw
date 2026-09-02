import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { withManagerBrowserLock } from './manager-browser-test-lock';

type BoxMetrics = {
    selector: string;
    display: string;
    gridTemplateColumns: string;
    height: number;
    right: number;
    width: number;
    x: number;
    y: number;
};

type LayoutMetrics = {
    viewport: { height: number; width: number };
    document: { bodyScrollWidth: number; clientWidth: number; scrollWidth: number };
    shell: BoxMetrics | null;
    workspace: BoxMetrics | null;
    command: BoxMetrics | null;
    detail: BoxMetrics | null;
    activity: BoxMetrics | null;
    mobileNav: BoxMetrics | null;
};

const CDP_URL = process.env.MANAGER_BROWSER_CDP_URL || 'http://127.0.0.1:9242';
const MANAGER_URL = process.env.MANAGER_DASHBOARD_URL || 'http://127.0.0.1:24576/';
const SCREENSHOT_DIR = process.env.MANAGER_SCREENSHOT_DIR || join(homedir(), '.cli-jaw', 'screenshots');
const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 756, height: 469 },
    { width: 390, height: 844 },
] as const;

const browsers: Browser[] = [];

function isDefaultMissingCdp(error: unknown): boolean {
    return !process.env.MANAGER_BROWSER_CDP_URL && String(error).includes('ECONNREFUSED');
}

async function pageForManager(t: TestContext): Promise<Page | null> {
    let browser: Browser;
    try {
        browser = await chromium.connectOverCDP(CDP_URL);
    } catch (error) {
        if (isDefaultMissingCdp(error)) {
            t.skip(`manager CDP browser is not running at ${CDP_URL}`);
            return null;
        }
        throw error;
    }
    browsers.push(browser);
    const context = await browser.newContext();
    return context.newPage();
}

async function selectFirstOnlineInstance(page: Page): Promise<void> {
    await page.waitForSelector('.dashboard-shell.manager-shell');
    const port = await page.evaluate(async () => {
        localStorage.setItem('jaw.previewEnabled', 'true');
        const response = await fetch('/api/dashboard/instances?showHidden=1');
        const data = await response.json() as { instances?: Array<{ port: number; ok: boolean }> };
        const selected = data.instances?.find(instance => instance.ok);
        if (!selected) throw new Error('No online instance available for preview smoke');
        await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ui: { sidebarMode: 'instances', selectedPort: selected.port, selectedTab: 'preview' } }),
        });
        return selected.port;
    });
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((selectedPort) => {
        return document.body.textContent?.includes(String(selectedPort)) ?? false;
    }, port);
}

async function measure(page: Page): Promise<LayoutMetrics> {
    return page.evaluate(`(() => {
        const read = (selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
                selector,
                display: style.display,
                gridTemplateColumns: style.gridTemplateColumns,
                height: Math.round(rect.height * 100) / 100,
                right: Math.round(rect.right * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
                x: Math.round(rect.x * 100) / 100,
                y: Math.round(rect.y * 100) / 100,
            };
        };

        return {
            viewport: { width: innerWidth, height: innerHeight },
            document: {
                clientWidth: document.documentElement.clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
                bodyScrollWidth: document.body.scrollWidth,
            },
            shell: read('.dashboard-shell.manager-shell'),
            workspace: read('.manager-workspace'),
            command: read('.manager-command'),
            detail: read('.manager-detail'),
            activity: read('.manager-activity'),
            mobileNav: read('.manager-mobile-nav'),
        };
    })()`) as Promise<LayoutMetrics>;
}

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
});

test('manager dashboard shell has measured layout coverage at critical viewports', async (t) => await withManagerBrowserLock(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const page = await pageForManager(t);
    if (!page) return;

    for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.dashboard-shell.manager-shell');
        await page.screenshot({
            fullPage: false,
            path: join(SCREENSHOT_DIR, `manager-layout-smoke-${viewport.width}x${viewport.height}.png`),
        });

        const metrics = await measure(page);
        assert.ok(metrics.shell, `${viewport.width}x${viewport.height}: shell must render`);
        assert.ok(metrics.workspace, `${viewport.width}x${viewport.height}: workspace must render`);
        assert.ok(metrics.command, `${viewport.width}x${viewport.height}: command must render`);
        assert.ok(metrics.detail, `${viewport.width}x${viewport.height}: detail/workbench must render`);

        assert.equal(metrics.document.scrollWidth, viewport.width, `${viewport.width}x${viewport.height}: no document horizontal overflow`);
        assert.equal(metrics.document.bodyScrollWidth, viewport.width, `${viewport.width}x${viewport.height}: no body horizontal overflow`);
        assert.ok(Math.abs(metrics.shell.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: shell uses full viewport width`);
        assert.ok(metrics.shell.right <= viewport.width + 1, `${viewport.width}x${viewport.height}: shell cannot create a blank right gutter`);
        assert.ok(Math.abs(metrics.workspace.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: workspace uses full viewport width`);
        assert.ok(metrics.workspace.right <= viewport.width + 1, `${viewport.width}x${viewport.height}: workspace cannot create a blank right gutter`);

        if (viewport.width <= 1023) {
            assert.ok(Math.abs(metrics.command.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: command uses full compact width`);
            assert.ok(Math.abs(metrics.detail.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: workbench uses full compact width`);
            assert.equal(
                metrics.workspace.gridTemplateColumns.includes('300px'),
                false,
                `${viewport.width}x${viewport.height}: compact shell must not leak desktop sidebar column`,
            );
        }

        if (viewport.width <= 767) {
            assert.ok(metrics.mobileNav, `${viewport.width}x${viewport.height}: mobile nav must render`);
            assert.notEqual(metrics.mobileNav.display, 'none', `${viewport.width}x${viewport.height}: mobile nav must be visible`);
            assert.ok(Math.abs(metrics.mobileNav.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: mobile nav uses full width`);
        }
    }
}));

test('manager preview iframe survives Workbench tab changes', async (t) => await withManagerBrowserLock(async () => {
    const page = await pageForManager(t);
    if (!page) return;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.dashboard-shell.manager-shell');
    await selectFirstOnlineInstance(page);

    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.waitForSelector('[data-preview-host="persistent"]');
    await page.waitForSelector('iframe.preview-frame', { timeout: 5000 });

    const before = await page.evaluate(() => {
        const host = document.querySelector('[data-preview-host="persistent"]');
        const frame = document.querySelector('iframe.preview-frame');
        (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame = frame;
        return {
            hostHidden: host?.hasAttribute('hidden') ?? null,
            hasFrame: Boolean(frame),
            src: frame?.getAttribute('src') || null,
        };
    });

    assert.equal(before.hostHidden, false, 'preview host should be visible on Preview tab');
    assert.equal(before.hasFrame, true, 'preview iframe should render for an online selected instance');

    await page.getByRole('tab', { name: 'Settings' }).click();

    const during = await page.evaluate(() => {
        const host = document.querySelector('[data-preview-host="persistent"]');
        const frame = document.querySelector('iframe.preview-frame');
        return {
            hostHidden: host?.hasAttribute('hidden') ?? null,
            sameFrame: frame === (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame,
            src: frame?.getAttribute('src') || null,
        };
    });

    assert.equal(during.hostHidden, true, 'preview host should be hidden off Preview tab');
    assert.equal(during.sameFrame, true, 'preview iframe must stay mounted while hidden');

    await page.getByRole('tab', { name: 'Preview' }).click();

    const after = await page.evaluate(() => {
        const host = document.querySelector('[data-preview-host="persistent"]');
        const frame = document.querySelector('iframe.preview-frame');
        return {
            hostHidden: host?.hasAttribute('hidden') ?? null,
            sameFrame: frame === (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame,
            src: frame?.getAttribute('src') || null,
        };
    });

    assert.equal(after.hostHidden, false, 'preview host should show again on Preview tab');
    assert.equal(after.sameFrame, true, 'preview iframe must remain the same DOM node after returning');
    assert.equal(after.src, before.src, 'preview source should not change across tab-only navigation');
}));

test('manager preview header toggles and refreshes the iframe', async (t) => await withManagerBrowserLock(async () => {
    const page = await pageForManager(t);
    if (!page) return;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
    await selectFirstOnlineInstance(page);

    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.waitForSelector('iframe.preview-frame', { timeout: 5000 });
    await page.getByRole('switch', { name: /Preview on/i }).click();
    await page.waitForSelector('iframe.preview-frame', { state: 'detached' });
    await page.getByRole('switch', { name: /Preview off/i }).click();
    await page.waitForSelector('iframe.preview-frame', { timeout: 5000 });

    const beforeRefresh = await page.evaluate(() => {
        const frame = document.querySelector('iframe.preview-frame');
        (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame = frame;
        return frame?.getAttribute('src') || null;
    });

    await page.locator('.preview-refresh-button').click();
    await page.waitForFunction(() => {
        const frame = document.querySelector('iframe.preview-frame');
        return Boolean(frame && frame !== (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame);
    });

    const afterRefresh = await page.evaluate(() => {
        const frame = document.querySelector('iframe.preview-frame');
        return frame?.getAttribute('src') || null;
    });

    assert.equal(afterRefresh, beforeRefresh, 'refresh must reload the existing preview URL without changing target');
}));

test('manager sidebar shell resizes, persists, resets, and collapses', async (t) => await withManagerBrowserLock(async () => {
    const page = await pageForManager(t);
    if (!page) return;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.dashboard-shell.manager-shell');
    await page.evaluate(() => localStorage.removeItem('jaw.sidebarWidth'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar-resize-handle');

    const readSidebar = () => page.evaluate(() => {
        const sidebar = document.querySelector('.manager-sidebar');
        const workspace = document.querySelector('.manager-workspace');
        const handle = document.querySelector('.sidebar-resize-handle');
        return {
            width: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
            cssVar: workspace ? getComputedStyle(workspace).getPropertyValue('--sidebar-width').trim() : null,
            stored: localStorage.getItem('jaw.sidebarWidth'),
            role: handle?.getAttribute('role') ?? null,
            valueNow: handle?.getAttribute('aria-valuenow') ?? null,
            collapsed: workspace?.classList.contains('is-sidebar-collapsed') ?? false,
        };
    });

    const initial = await readSidebar();
    assert.equal(initial.width, 300, 'sidebar default width is the cli-jaw DEFAULT (300px)');
    assert.equal(initial.cssVar, '300px', 'WorkspaceLayout owns --sidebar-width');
    assert.equal(initial.role, 'separator', 'resize handle must be a focusable separator');
    assert.equal(initial.valueNow, '300', 'resize handle exposes the current width');

    const box = await page.locator('.sidebar-resize-handle').boundingBox();
    assert.ok(box, 'resize handle must have a layout box');
    const startX = box.x + box.width / 2;
    const y = box.y + 200;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
        await page.mouse.move(startX + step * 10, y);
        await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
    const dragged = await readSidebar();
    assert.equal(dragged.width, 420, 'dragging the handle 120px widens the sidebar to 420px');
    assert.equal(dragged.stored, '420', 'the width is persisted under jaw.sidebarWidth');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar-resize-handle');
    const restored = await readSidebar();
    assert.equal(restored.width, 420, 'the persisted width survives a reload');

    const box2 = await page.locator('.sidebar-resize-handle').boundingBox();
    assert.ok(box2, 'resize handle must still be mounted after reload');
    await page.mouse.dblclick(box2.x + box2.width / 2, box2.y + 200);
    // the grid column animates 180ms (--motion-base); wait for it to settle
    await page.waitForTimeout(400);
    const reset = await readSidebar();
    assert.equal(reset.width, 300, 'double-click resets the width to the default');
    assert.equal(reset.stored, null, 'reset removes the persisted key');

    await page.keyboard.press('Meta+Shift+B');
    await page.waitForFunction(() => document.querySelector('.manager-workspace')?.classList.contains('is-sidebar-collapsed'));
    await page.waitForTimeout(400);
    const collapsed = await readSidebar();
    assert.equal(collapsed.width, 44, 'collapsed sidebar leaves the 44px rail');
    assert.equal(collapsed.cssVar, '44px', 'collapsed width comes from the hook constant');
    await page.keyboard.press('Meta+Shift+B');
}));

