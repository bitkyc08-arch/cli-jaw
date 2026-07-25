/*
 * Shared plumbing for the dashboard2 QA harness.
 *
 * One place owns the surface definitions so enumerate-interactives, sweep and
 * axe-scan cannot drift apart about what "the sidebar" means.
 */
import { chromium } from 'playwright';

/**
 * How to reach each scored surface.
 *
 * `root` scopes element enumeration; `reach` runs the clicks needed to make the
 * surface visible. Keep names aligned with the work-phase table in
 * devlog/260725_dashboard2_overnight_qa_stabilization/011_acceptance_matrix.md.
 */
export const SURFACES = {
    sidebar: {
        owner: 'wp2',
        root: '.d2-sidebar-v4',
        reach: async () => {},
    },
    workbench: {
        owner: 'wp3',
        root: '.d2-workbench',
        reach: async (page) => { await selectFirstOnlineInstance(page); },
    },
    composer: {
        owner: 'wp4',
        root: '.d2-chat-composer-slot',
        reach: async (page) => { await selectFirstOnlineInstance(page); },
    },
    'side-pane': {
        owner: 'wp5a',
        root: '.d2-side-pane',
        reach: async (page) => {
            await selectFirstOnlineInstance(page);
            const toggle = page.getByRole('button', { name: /open side pane/i });
            if (await toggle.count()) await toggle.first().click().catch(() => {});
        },
    },
    settings: {
        owner: 'wp6',
        root: '.d2-settings-modal',
        reach: async (page) => {
            const gear = page.locator('.d2-sidebar-settings');
            if (await gear.count()) await gear.first().click();
        },
    },
    'hover-dock': {
        owner: 'wp7a',
        root: '.d2-hover-dock',
        reach: async (page) => {
            await selectFirstOnlineInstance(page);
            const trigger = page.locator('.d2-hover-dock-trigger');
            if (await trigger.count()) await trigger.first().click().catch(() => {});
        },
    },
};

async function selectFirstOnlineInstance(page) {
    const online = page.locator('.d2-instance-main:not([disabled])');
    if (await online.count()) {
        await online.first().click();
        await page.waitForTimeout(1500);
    }
}

export async function resolveSurface(page, surface) {
    await surface.reach(page);
    await page.waitForTimeout(500);
}

/**
 * Chrome is used rather than bundled chromium because this repo does not vendor
 * playwright browsers; `npx playwright install` is not assumed.
 */
export async function launch(url, { viewport = { width: 1440, height: 900 } } = {}) {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport });
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2500);
    page.consoleErrors = consoleErrors;
    return { browser, page };
}
