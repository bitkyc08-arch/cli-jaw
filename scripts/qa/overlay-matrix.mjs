#!/usr/bin/env node
/*
 * M4 gate: the eight overlays 011 fixes as the denominator, each checked
 * against its TYPE's requirements (011 §오버레이 유형별 요구사항):
 *
 *   modal   focus trap + Escape + focus restore + background inert
 *   popover Escape + focus restore (no trap required)
 *   menu    Escape + focus restore + arrow-key cycling
 *
 * An overlay that cannot be activated is a FAIL, never an n/a: the
 * denominator is fixed, so an unopened overlay scores 0 for its owner.
 *
 * All keyboard probes use Playwright's trusted events (page.keyboard), not
 * synthetic dispatches — a focus trap proven with untrusted Tab events
 * proves nothing about the browser's native focus movement.
 *
 * Usage:
 *   node scripts/qa/overlay-matrix.mjs --out evidence/wp14/m4.json
 *   node scripts/qa/overlay-matrix.mjs --overlay settings-modal --out evidence/wp14/m4-settings-modal.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { startFixtureServer, openFixture } from './fixture-lib.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};
const only = flag('overlay');
const outPath = flag('out');

/** Shapes pinned to the adapters (scenario-feature-ledger.mjs owns the originals). */
const SCHED_ITEM = {
    id: 'sched-1', title: 'wp14 scheduled work', group: 'today', cron: '0 9 * * *',
    runAt: null, enabled: true, targetPort: 3506, nextRunAt: null, lastRunAt: null,
    lastStatus: null, createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
};
const OPEN_REMINDER = {
    id: 'rem-1', title: 'wp14 open reminder', notes: '', listId: 'default', status: 'open',
    priority: 'normal', manualRank: null, dueAt: null, remindAt: null, linkedInstance: null,
    subtasks: [], sourceCreatedAt: '2026-07-26T00:00:00.000Z', sourceUpdatedAt: '2026-07-26T00:00:00.000Z',
};

const OVERLAYS = [
    {
        id: 'settings-modal', owner: 'wp6', type: 'modal',
        root: '.d2-settings-modal [role="dialog"]',
        opener: '.d2-sidebar-settings',
        open: async (page) => { await page.locator('.d2-sidebar-settings').first().click(); },
    },
    {
        id: 'board-task-dialog', owner: 'wp5c', type: 'modal',
        root: '.d2-board-dialog[role="dialog"]',
        // The card body carries role=button + tabIndex; the card itself does not.
        opener: '.d2-board-card-body',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('board'));
            await page.locator('.d2-board-card-body').first().waitFor();
        },
        open: async (page) => { await page.locator('.d2-board-card-body').first().click(); },
    },
    {
        id: 'schedule-work-editor', owner: 'wp5c', type: 'modal',
        root: '.d2-schedule-editor[role="dialog"]',
        opener: '[aria-label^="Edit scheduled work"]',
        reach: async (page) => {
            await page.evaluate((item) => window.__jawE2E.setSchedule({ items: [item] }), SCHED_ITEM);
            await page.evaluate(() => window.__jawE2E.openPanel('reminders'));
            await page.locator('.d2-reminders-tabs [role="tab"]', { hasText: 'Schedule' }).first().click();
            await page.locator('[aria-label^="Edit scheduled work"]').first().waitFor();
        },
        open: async (page) => { await page.locator('[aria-label^="Edit scheduled work"]').first().click(); },
    },
    {
        id: 'notes-quick-switcher', owner: 'wp5c', type: 'modal',
        root: '.d2-notes-quick-switcher[role="dialog"]',
        // Keyboard-opened: focus restore targets whatever was focused before,
        // so the harness focuses a stable notes-panel element first.
        opener: '.d2-notes-panel button',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('notes'));
            await page.locator('.d2-notes-panel button').first().waitFor();
        },
        open: async (page) => { await page.keyboard.press('Meta+P'); },
    },
    {
        id: 'notes-command-palette', owner: 'wp5c', type: 'modal',
        root: '.d2-notes-command-palette[role="dialog"]',
        opener: '.d2-notes-panel button',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('notes'));
            await page.locator('.d2-notes-panel button').first().waitFor();
        },
        open: async (page) => { await page.keyboard.press('Meta+Shift+P'); },
    },
    {
        id: 'reminder-edit-popover', owner: 'wp5c', type: 'popover',
        root: '.d2-reminder-edit[role="dialog"]',
        // The dedicated Edit button is the keyboard-reachable opener; the
        // card click is the mouse path to the same popover.
        opener: '.d2-reminders-card [aria-label^="Edit "]',
        reach: async (page) => {
            await page.evaluate((item) => window.__jawE2E.setReminders({ items: [item] }), OPEN_REMINDER);
            await page.evaluate(() => window.__jawE2E.openPanel('reminders'));
            await page.locator('.d2-reminders-card [aria-label^="Edit "]').first().waitFor();
        },
        open: async (page) => { await page.locator('.d2-reminders-card [aria-label^="Edit "]').first().click(); },
    },
    {
        id: 'sidepane-overflow-menu', owner: 'wp5a', type: 'menu',
        root: '.d2-side-pane-overflow-dropdown',
        opener: '.d2-side-pane-overflow-trigger',
        reach: async (page) => {
            // The trigger only renders when the open tabs overflow the strip.
            for (const panel of ['terminal', 'files', 'diff', 'notes', 'board', 'reminders', 'code']) {
                await page.evaluate((name) => window.__jawE2E.openPanel(name), panel);
            }
            await page.locator('.d2-side-pane-overflow-trigger').first().waitFor();
        },
        open: async (page) => { await page.locator('.d2-side-pane-overflow-trigger').first().click(); },
    },
    {
        id: 'instance-action-menu', owner: 'wp2', type: 'menu',
        root: '.d2-instance-menu[role="menu"]',
        opener: '.d2-instance-more',
        reach: async (page) => {
            // The more-button only becomes visible while its row is hovered;
            // the focus step needs it visible BEFORE the click.
            await page.locator('.d2-instance-row').first().hover();
            await page.locator('.d2-instance-more').first().waitFor();
        },
        open: async (page) => {
            await page.locator('.d2-instance-row').first().hover();
            await page.locator('.d2-instance-more').first().click();
        },
    },
];

const TYPE_CHECKS = {
    modal: ['trap', 'escape', 'focusRestore', 'inert'],
    popover: ['escape', 'focusRestore'],
    menu: ['escape', 'focusRestore', 'arrowCycle'],
};

if (!outPath) {
    console.error('Usage: overlay-matrix.mjs [--overlay <id>] --out <path>');
    process.exit(2);
}

const targets = only ? OVERLAYS.filter((o) => o.id === only) : OVERLAYS;
if (targets.length === 0) {
    console.error(`Unknown overlay "${only}". Known: ${OVERLAYS.map((o) => o.id).join(', ')}`);
    process.exit(2);
}

/** document.activeElement as a stable descriptor for focus-restore comparison. */
async function focusDescriptor(page) {
    return page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        return {
            tag: el.tagName,
            cls: typeof el.className === 'string' ? el.className : '',
            label: el.getAttribute('aria-label'),
            text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
            body: el === document.body,
        };
    });
}

async function insideRoot(page, root) {
    return page.evaluate((selector) => {
        const el = document.activeElement;
        const overlay = document.querySelector(selector);
        return Boolean(overlay && el && (overlay === el || overlay.contains(el)));
    }, root);
}

async function runOverlay(server, overlay) {
    const { browser, page } = await openFixture(server.url, { historyCount: 5 });
    const checks = {};
    try {
        // Reach the opener's surface, then focus the opener so focusRestore
        // has a reference point, then activate the overlay itself.
        if (overlay.reach) await overlay.reach(page);
        await page.locator(overlay.opener).first().waitFor({ state: 'attached', timeout: 8000 });
        await page.locator(overlay.opener).first().focus().catch(() => {});
        const before = await focusDescriptor(page);

        await overlay.open(page);
        const opened = await page.locator(overlay.root).first().waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
        if (!opened) {
            return { id: overlay.id, owner: overlay.owner, type: overlay.type, verdict: 'fail', activation: 'failed' };
        }
        checks.activation = 'pass';

        const wanted = TYPE_CHECKS[overlay.type];

        if (wanted.includes('trap')) {
            // Tab through more stops than the overlay can have; focus must
            // never leave it, forward or backward.
            let trapped = true;
            for (let i = 0; i < 12 && trapped; i += 1) {
                await page.keyboard.press('Tab');
                trapped = await insideRoot(page, overlay.root);
            }
            for (let i = 0; i < 3 && trapped; i += 1) {
                await page.keyboard.press('Shift+Tab');
                trapped = await insideRoot(page, overlay.root);
            }
            checks.trap = trapped ? 'pass' : 'fail';
        }

        if (wanted.includes('inert')) {
            checks.inert = await page.evaluate(() => {
                // The background is inert when the app's main regions sit
                // inside an inert subtree (SettingsModal inerts the overlay's
                // siblings). A backdrop alone does not satisfy this — it
                // blocks the pointer, not the keyboard.
                const regions = ['.d2-workbench', '.d2-sidebar-v4'];
                return regions.some((selector) => document.querySelector(selector)?.closest('[inert]') !== null
                    && document.querySelector(selector)?.closest('[inert]') !== undefined);
            }) ? 'pass' : 'fail';
        }

        if (wanted.includes('arrowCycle')) {
            const start = await focusDescriptor(page);
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(120);
            const moved = await focusDescriptor(page);
            const movedWithin = await insideRoot(page, overlay.root)
                || await page.evaluate((selector) => {
                    const overlayEl = document.querySelector(selector);
                    const active = overlayEl?.getAttribute('aria-activedescendant');
                    return Boolean(overlayEl && active && overlayEl.querySelector(`#${CSS.escape(active)}`));
                }, overlay.root);
            const changed = JSON.stringify(start) !== JSON.stringify(moved);
            checks.arrowCycle = movedWithin && changed ? 'pass' : 'fail';
            if (checks.arrowCycle === 'fail') checks.arrowCycleDetail = { start, moved, movedWithin };
        }

        if (wanted.includes('escape')) {
            await page.keyboard.press('Escape');
            const closed = await page.locator(overlay.root).waitFor({ state: 'detached', timeout: 3000 }).then(() => true).catch(() => false);
            checks.escape = closed ? 'pass' : 'fail';
        }

        if (wanted.includes('focusRestore')) {
            // Components restore in a rAF after the close commit; give that
            // frame a chance to run before reading.
            await page.waitForTimeout(150);
            const after = await focusDescriptor(page);
            const restored = after && !after.body
                && (JSON.stringify(after) === JSON.stringify(before)
                    || (after.label !== null && after.label === before?.label));
            checks.focusRestore = restored ? 'pass' : 'fail';
            if (!restored) checks.focusRestoreDetail = { before, after };
        }

        const failedChecks = Object.entries(checks).filter(([, verdict]) => verdict === 'fail').map(([name]) => name);
        return {
            id: overlay.id,
            owner: overlay.owner,
            type: overlay.type,
            verdict: failedChecks.length ? 'fail' : 'pass',
            checks,
            failed: failedChecks,
        };
    } catch (error) {
        return { id: overlay.id, owner: overlay.owner, type: overlay.type, verdict: 'fail', activation: 'error', error: String(error).slice(0, 300) };
    } finally {
        await browser.close();
    }
}

const server = await startFixtureServer();
const rows = [];
try {
    for (const overlay of targets) {
        const row = await runOverlay(server, overlay);
        rows.push(row);
        console.log(`${row.id}: ${row.verdict}${row.failed?.length ? ` (${row.failed.join(', ')})` : ''}${row.activation === 'failed' ? ' (activation)' : ''}`);
    }
} finally {
    server.close();
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({
    when: new Date().toISOString(),
    overlays: rows,
    passed: rows.filter((r) => r.verdict === 'pass').length,
    total: rows.length,
}, null, 2));
console.error(`wrote ${outPath}`);

if (rows.some((r) => r.verdict !== 'pass')) process.exit(1);
