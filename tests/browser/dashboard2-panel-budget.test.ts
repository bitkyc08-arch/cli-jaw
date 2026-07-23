import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { collectHeapUsagePostGc, sampleDomCountersMedian } from '../helpers/cdp-budget.ts';
import type { BudgetPanelType, PanelBudgetCacheCounters } from '../../public/dashboard2/src/dev/panel-budget-harness.tsx';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EVIDENCE_PATH = join(ROOT, 'refs/091-baseline-full-budget.json');
const MIB = 1024 * 1024;
const PANEL_TYPES: BudgetPanelType[] = ['terminal', 'browser', 'files', 'notes', 'board', 'reminders', 'doc', 'diff', 'design'];
const CLOSE_CAPS: Record<BudgetPanelType, number> = {
    terminal: 4 * MIB, browser: 8 * MIB, files: 16 * MIB, notes: 16 * MIB,
    board: 16 * MIB, reminders: 16 * MIB, doc: 16 * MIB, diff: 16 * MIB, design: 16 * MIB,
};
const OPEN_CAPS: Partial<Record<BudgetPanelType, number>> = { terminal: 24 * MIB, files: 16 * MIB };
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    await Promise.allSettled(servers.map((server) => server.close()));
});

async function launch(t: TestContext): Promise<Browser | null> {
    for (const attempt of [
        () => chromium.launch({ headless: true, executablePath: process.env.JAW_BUDGET_CHROME }),
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        if (attempt === undefined) continue;
        try {
            const browser = await attempt();
            browsers.push(browser);
            return browser;
        } catch { /* local fallback */ }
    }
    t.skip('no local Chrome/Chromium');
    return null;
}

function json(route: Route, body: unknown): Promise<void> {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function routeFixtures(page: Page): Promise<void> {
    await page.route('**/panel-budget-frame.html', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>panel budget</title><main>fixture frame</main>',
    }));
    await page.route('**/api/dashboard/instances', (route) => json(route, {
        manager: null, peerDashboards: [], platform: 'darwin',
        instances: [{ port: 4242, status: 'running', workingDir: '/fixture', sessionId: 'panel-budget-session' }],
    }));
    await page.route('**/api/dashboard/board/tasks**', (route) => json(route, { ok: true, tasks: [] }));
    await page.route('**/api/dashboard/reminders**', (route) => json(route, { ok: true, items: [] }));
    await page.route('**/api/dashboard/schedule/work**', (route) => json(route, { ok: true, items: [] }));
    await page.route('**/api/dashboard/notes/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/tree')) return json(route, []);
        if (path.endsWith('/index')) return json(route, { version: 1, notes: [], backlinks: {}, outgoingLinks: {} });
        if (path.endsWith('/version')) return json(route, { version: 1 });
        if (path.endsWith('/info')) return json(route, { root: '/fixture' });
        return json(route, []);
    });
}

async function installDesktopFakes(page: Page): Promise<void> {
    const install = () => {
        let terminalOrdinal = 0;
        const entries = Array.from({ length: 200 }, (_, index) => ({
            name: `directory-${String(index).padStart(3, '0')}`, path: `/fixture/directory-${index}`, kind: 'directory', size: 0,
        }));
        const nestedEntries = Array.from({ length: 49 }, (_, index) => ({
            name: `nested-${index}.ts`, path: `nested-${index}.ts`, kind: 'file', size: 64,
        }));
        (window as unknown as Record<string, unknown>).cliJawDesktop = {
            terminal: {
                list: async () => ({ ok: true, sessions: [] }),
                create: async (opts: { cwd?: string }) => ({ ok: true, id: `term-${++terminalOrdinal}`, shell: '/bin/zsh', cwd: opts.cwd ?? '/fixture' }),
                write: async () => {}, resize: async () => {}, kill: async () => {},
                onData: () => () => {}, onExit: () => () => {},
            },
            folder: {
                getDefaultRoot: async () => ({ ok: true, path: '/fixture' }),
                pickFolder: async () => ({ ok: true, path: '/fixture' }), pickFile: async () => ({ ok: false }),
                authorizeRoot: async (path: string) => ({ ok: true, path }), registerGitWorktreeRoot: async () => ({ ok: true, path: '/fixture' }),
                listDir: async (path: string) => ({ ok: true, entries: path === '/fixture' ? entries : nestedEntries.map((entry) => ({ ...entry, path: `${path}/${entry.path}` })) }), readFile: async () => ({ ok: true, content: 'fixture' }),
                movePath: async () => ({ ok: false }), createFile: async () => ({ ok: false }), createFolder: async () => ({ ok: false }),
                renamePath: async () => ({ ok: false }), revealPath: async () => ({ ok: true }), watchDir: async () => ({ ok: true }),
                unwatchDir: async () => ({ ok: true }), onDirChange: () => () => {},
            },
            diff: {
                getRepoRoot: async () => ({ ok: true, root: '/fixture' }), getRepoCandidates: async () => ({ ok: true, candidates: [] }),
                getScmSnapshot: async () => ({ ok: true, snapshot: { repoRoot: '/fixture', branch: 'dev2', head: 'fixture', dirty: true, groups: [] } }),
                runScmOperation: async () => ({ ok: false }),
                getDiffSummary: async () => ({ ok: true, files: [{ path: 'src/example.ts', status: 'M', insertions: 1, deletions: 1 }] }),
                getFileDiff: async () => ({ ok: true, diff: 'diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new' }),
            },
        };
    };
    await page.evaluate(`const __name = (fn) => fn; (${install.toString()})();`);
}

async function exercisePanel(page: Page, type: BudgetPanelType): Promise<void> {
    if (type === 'terminal') {
        const input = page.locator('.xterm-helper-textarea');
        await input.waitFor({ state: 'attached', timeout: 5_000 }).catch(async () => {
            throw new Error(`terminal did not mount xterm: ${await page.locator('.d2-side-pane-tab-slot[data-tab="terminal"]').innerHTML()}`);
        });
        await input.evaluate((element) => (element as HTMLTextAreaElement).focus());
        for (let index = 0; index < 20; index += 1) {
            await page.keyboard.press(String(index % 10));
            await page.locator('.d2-side-pane').evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px`; }, 560 + index % 2);
        }
        return;
    }
    if (type === 'browser') {
        const input = page.getByRole('textbox', { name: 'URL' });
        for (let index = 0; index < 10; index += 1) {
            await input.fill(`${new URL(page.url()).origin}/panel-budget-frame.html?nav=${index}`);
            await page.getByRole('button', { name: 'Go' }).click();
            await page.locator('iframe[title="Browser preview"]').waitFor();
        }
        return;
    }
    if (type === 'files') {
        await page.waitForFunction(() => document.querySelectorAll('.d2-file-node').length > 0);
        await page.evaluate(async (steps) => {
            for (let index = 0; index < steps; index += 1) {
                document.querySelector<HTMLButtonElement>('.d2-file-node')?.click();
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
        }, 200);
        await page.locator('.d2-file-tree').evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await page.locator('.d2-file-tree').evaluate((element) => { element.scrollTop = 0; });
    }
}

function updateEvidence(panelBudget: unknown, cacheThreshold: unknown): void {
    const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as Record<string, unknown>;
    evidence.measuredAt = new Date().toISOString();
    evidence.panelBudget = panelBudget;
    evidence.cacheThreshold = cacheThreshold;
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
}

test('091 panel budget: every mountable SidePane type stays within retained heap and DOM caps', { timeout: 300_000 }, async (t) => {
    const browser = await launch(t);
    if (!browser) return;
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen();
    servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('vite bind failed');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    await routeFixtures(page);
    await page.route('**/dashboard2/src/main.tsx*', (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await installDesktopFakes(page);
    await page.evaluate(async () => {
        const module = await import('/dist/dashboard2/src/dev/panel-budget-harness.tsx');
        module.mountPanelBudgetHarness(document.querySelector<HTMLElement>('#dashboard2-root')!);
    });
    await page.waitForFunction(() => Boolean(window.__jawPanelBudget));
    await page.waitForFunction(() => window.__jawPanelBudget?.snapshot().selected === true);
    const session = await context.newCDPSession(page);
    const baselineHeap = await collectHeapUsagePostGc(session);
    const baselineDom = await sampleDomCountersMedian(session, 3);
    const rows: Array<Record<string, unknown>> = [];

    for (const type of PANEL_TYPES) {
        const panelBaselineHeap = await collectHeapUsagePostGc(session);
        const panelBaselineDom = await sampleDomCountersMedian(session, 3);
        await page.evaluate((panelType) => window.__jawPanelBudget!.open(panelType), type);
        await page.waitForFunction((panelType) => window.__jawPanelBudget?.snapshot().activeType === panelType, type);
        await page.locator(`.d2-side-pane-tab-slot[data-tab="${type}"]`).waitFor({ state: 'visible' });
        await exercisePanel(page, type);
        console.log(`[091 panel progress] ${type} exercised`);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const openHeap = await collectHeapUsagePostGc(session);
        const openDom = await sampleDomCountersMedian(session, 3);
        const mountedRows = type === 'files' ? await page.locator('.d2-file-node').count() : null;
        const openDeltaBytes = openHeap.usedSizeBytes - panelBaselineHeap.usedSizeBytes;
        const openCapBytes = OPEN_CAPS[type] ?? null;
        if (openCapBytes !== null) assert.ok(openDeltaBytes <= openCapBytes, `${type} open delta ${openDeltaBytes}B <= ${openCapBytes}B`);
        assert.ok(openDom.nodes <= 2_500, `${type} DOM ${openDom.nodes} <= 2500`);
        if (type === 'files') assert.ok((mountedRows ?? Infinity) <= 300, `files mounted rows ${mountedRows} <= 300`);

        assert.equal(await page.evaluate(() => window.__jawPanelBudget!.closeActive()), true);
        await page.waitForFunction(() => window.__jawPanelBudget?.snapshot().panelCount === 0);
        const closedHeap = await collectHeapUsagePostGc(session);
        const closedDom = await sampleDomCountersMedian(session, 3);
        const retainedBytes = Math.max(0, closedHeap.usedSizeBytes - panelBaselineHeap.usedSizeBytes);
        const retainedCapBytes = CLOSE_CAPS[type];
        assert.ok(retainedBytes <= retainedCapBytes, `${type} retained ${retainedBytes}B <= ${retainedCapBytes}B`);
        rows.push({ type, baselineHeapBytes: panelBaselineHeap.usedSizeBytes, baselineDomNodes: panelBaselineDom.nodes, openDeltaBytes, openCapBytes, retainedBytes, retainedCapBytes, openDomNodes: openDom.nodes, closedDomNodes: closedDom.nodes, mountedRows, ...(type === 'files' ? { fixtureNodeCount: 10_000, expandCollapseActions: 200 } : {}), pass: true });
    }

    const cache = await page.evaluate(() => window.__jawPanelBudget!.cacheCounters()) as PanelBudgetCacheCounters;
    const cacheChecks = {
        markdown: { ...cache.markdown, capEntries: 256, capBytes: 16 * MIB, pass: cache.markdown.count <= 256 && cache.markdown.bytes <= 16 * MIB },
        height: { ...cache.height, capEntries: 10_000, capBytes: 2 * MIB, pass: cache.height.count <= 10_000 && cache.height.bytes <= 2 * MIB },
        highlight: { ...cache.highlight, capEntries: 128, capBytes: 4 * MIB, pass: cache.highlight.count <= 128 && cache.highlight.bytes <= 4 * MIB },
        total: { bytes: cache.totalBytes, capBytes: 32 * MIB, pass: cache.totalBytes <= 32 * MIB },
        liveSlots: { value: cache.liveSlots, cap: 1, pass: cache.liveSlots <= 1 },
        hitRates: { status: 'UNAVAILABLE', reason: 'render cache exposes pool occupancy but not markdown/height hit counters' },
    };
    assert.ok(Object.values(cacheChecks).filter((value): value is { pass: boolean } => typeof value === 'object' && value !== null && 'pass' in value).every((value) => value.pass));
    updateEvidence({ status: 'PASS', runtime: 'headless-chrome', baseline: { heapBytes: baselineHeap.usedSizeBytes, domNodes: baselineDom.nodes }, rows }, { status: 'PASS', ...cacheChecks });
    console.log('[091 panel budget report]', JSON.stringify({ baselineHeapBytes: baselineHeap.usedSizeBytes, baselineDomNodes: baselineDom.nodes, rows, cache: cacheChecks }));
});
