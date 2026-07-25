// wp13 B1 — deterministic fixtures for the visual gates.
//
// Until now every gate ran against the live app on :24577, which means the
// verdict depended on how many instances happened to be running, which session
// was last selected, and whatever the sidebar had scrolled to. A gate whose
// answer changes with the machine's mood is a report.
//
// dashboard2 already ships what is needed: `dev/e2e-app-harness.tsx` replaces
// the API and SSE with a FakeApiRouter and a DeterministicSseController, and
// exposes `window.__jawE2E` for navigation. Four e2e tests already use it. This
// wires the same harness into the visual scan.
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Vite serving `public/`, so the harness module resolves the way tests expect. */
export async function startFixtureServer() {
    const { createServer } = await import('vite');
    const server = await createServer({
        configFile: join(ROOT, 'vite.config.ts'),
        root: join(ROOT, 'public'),
        logLevel: 'silent',
        server: { port: 0, host: '127.0.0.1', hmr: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('vite failed to bind');
    return {
        url: `http://127.0.0.1:${address.port}/dist/dashboard2/index.html`,
        close: () => server.close(),
    };
}

/**
 * A page running the fixture harness rather than the live app.
 *
 * `historyCount` is the only knob the surfaces need: the turn stream wants
 * enough turns to fill a viewport, everything else is happier small and fast.
 */
export async function openFixture(url, { historyCount = 40, viewport = { width: 1440, height: 900 } } = {}) {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.addInitScript(() => {
        Object.defineProperty(window, '__name', { configurable: true, value: (fn) => fn });
        localStorage.clear();
        sessionStorage.clear();
    });
    await page.route('**/dashboard2/src/main.tsx*', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: `import { mountE2EAppHarness } from "/dist/dashboard2/src/dev/e2e-app-harness.tsx";`
            + ` mountE2EAppHarness(document.querySelector("#dashboard2-root"), { historyCount: ${historyCount} });`,
    }));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('chat-view').waitFor({ timeout: 20_000 });

    page.consoleErrors = consoleErrors;
    return { browser, context, page };
}

/**
 * How to reach each surface in the fixture.
 *
 * Every entry ends in an assertion, not a sleep. If the surface does not
 * appear, `reach` throws and the scan records a hard failure — the old
 * `.click().catch(() => {})` turned a missing surface into a clean report.
 *
 * `scope` narrows the measured region so a parent surface does not re-measure
 * a child that has its own entry: `.d2-workbench` contains the composer and the
 * side pane, and counting those twice inflates the gate total for free.
 */
export const FIXTURE_SURFACES = {
    sidebar: {
        root: '.d2-sidebar-v4',
        reach: async (page) => { await page.locator('.d2-sidebar-v4').waitFor(); },
    },
    workbench: {
        root: '.d2-workbench',
        exclude: ['.d2-chat-composer-slot', '.d2-side-pane'],
        reach: async (page) => { await page.getByTestId('chat-view').waitFor(); },
    },
    composer: {
        root: '.d2-chat-composer-slot',
        reach: async (page) => { await page.locator('.d2-chat-composer-slot').waitFor(); },
    },
    settings: {
        root: '.d2-settings-page',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.setSettings());
            await page.locator('.d2-settings-page').waitFor();
        },
    },
    notes: {
        root: '.d2-notes-panel',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('notes'));
            await page.locator('.d2-notes-panel').waitFor();
        },
    },
    board: {
        root: '.d2-board-panel',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('board'));
            await page.locator('.d2-board-panel').waitFor();
        },
    },
    'side-pane': {
        root: '.d2-side-pane',
        exclude: ['.d2-notes-panel', '.d2-board-panel', '.d2-code-tab'],
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('files'));
            await page.locator('.d2-side-pane').waitFor();
        },
    },
};
