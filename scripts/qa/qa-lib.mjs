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
        // The dock predates the d2- convention and uses a bare `hover-dock`
        // prefix. The old selectors never matched, so every dock scan reported
        // "not reached" — which earlier runs then read as "no defects".
        root: '.hover-dock-panel',
        reach: async (page) => {
            await selectFirstOnlineInstance(page);
            const trigger = page.locator('.hover-dock-trigger');
            if (await trigger.count()) {
                await trigger.first().click().catch(() => {});
                await page.waitForTimeout(600);
            }
        },
    },
};

/**
 * Open one of the side pane's feature panels.
 *
 * `side-pane` on its own only ever showed whichever panel happened to be
 * restored, so notes, board and the code tab were never measured. Each is a
 * separate surface with its own typography, controls and empty states.
 */
async function openPanel(page, title) {
    await selectFirstOnlineInstance(page);
    const paneToggle = page.getByRole('button', { name: /open side pane/i });
    if (await paneToggle.count()) await paneToggle.first().click().catch(() => {});
    await page.waitForTimeout(400);

    // Already open? Select its tab instead of opening a duplicate.
    const tab = page.locator(`.d2-side-pane-tab-group [role="tab"]`, { hasText: title });
    if (await tab.count()) {
        await tab.first().click().catch(() => {});
        await page.waitForTimeout(900);
        return;
    }

    const picker = page.getByRole('button', { name: /^open panel$/i });
    if (await picker.count()) {
        await picker.first().click().catch(() => {});
        await page.waitForTimeout(400);
        const choice = page.locator('.d2-side-pane-picker-button', { hasText: title });
        if (await choice.count()) await choice.first().click().catch(() => {});
    }
    await page.waitForTimeout(1200);
}

SURFACES.notes = {
    owner: 'wp13',
    root: '.d2-notes-panel',
    reach: (page) => openPanel(page, 'Notes'),
};

SURFACES.board = {
    owner: 'wp13',
    root: '.d2-board-panel',
    reach: (page) => openPanel(page, 'Board'),
};

SURFACES.code = {
    owner: 'wp13',
    // The gate renders first and swaps itself for the tab; both are in scope
    // because the gate's four states are part of what has to look right.
    root: '.d2-code-tab, .d2-code-gate',
    reach: (page) => openPanel(page, 'Code'),
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
