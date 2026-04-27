import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';

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

let browser: Browser | null = null;

async function pageForManager(): Promise<Page> {
    browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0] ?? await browser.newContext();
    return context.pages()[0] ?? await context.newPage();
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
    await browser?.close();
});

test('manager dashboard shell has measured layout coverage at critical viewports', async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const page = await pageForManager();

    for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
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
});
