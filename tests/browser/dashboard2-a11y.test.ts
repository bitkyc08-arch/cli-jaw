import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import axe from 'axe-core';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { collectContrastTable, type ContrastEvidence } from '../fixtures/dashboard2/a11y-contrast.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EVIDENCE_PATH = join(ROOT, 'refs', '090-a11y-evidence.json');
const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 720, height: 900 },
] as const;
const THEMES = ['dark', 'light'] as const;
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];

interface AxeNodeEvidence { target: string[]; html: string; failureSummary: string | null }
interface AxeViolationEvidence {
    id: string;
    impact: string | null;
    description: string;
    help: string;
    helpUrl: string;
    nodes: AxeNodeEvidence[];
}
after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launchBrowser(): Promise<Browser> {
    for (const launch of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try {
            const browser = await launch();
            browsers.push(browser);
            return browser;
        } catch { /* use the next installed browser */ }
    }
    throw new Error('090 a11y hard gate requires a local Chrome/Chromium executable');
}

async function startVite(): Promise<string> {
    const { createServer } = await import('vite');
    const server = await createServer({
        configFile: join(ROOT, 'vite.config.ts'),
        root: join(ROOT, 'public'),
        logLevel: 'silent',
        server: { port: 0, host: '127.0.0.1', hmr: false },
    });
    await server.listen();
    servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('Vite failed to bind');
    return `http://127.0.0.1:${address.port}`;
}

function json(route: Route, body: unknown): Promise<void> {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function installRoutes(page: Page, theme: typeof THEMES[number], sent: string[]): Promise<void> {
    const ui = {
        uiTheme: theme,
        locale: 'en',
        dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: {},
        chatLinkPreviewsEnabled: false,
    };
    await page.route('**/api/dashboard/registry', route => json(route, { registry: { ui }, status: { source: 'fixture' } }));
    await page.route('**/api/dashboard/instances', route => json(route, {
        manager: null,
        peerDashboards: [],
        platform: 'darwin',
        instances: [{
            port: 3506,
            label: 'A11y fixture',
            workingDir: '/tmp/a11y-fixture',
            projectDirs: ['/tmp/a11y-fixture'],
            status: 'online',
            lifecycle: {
                owner: 'process', canStart: false, canStop: false, canRestart: false, canPerm: false,
                reason: 'Fixture controls are read only',
            },
        }],
    }));
    await page.route('**/i/3506/api/chat-sessions', route => json(route, {
        ok: true,
        data: {
            active: 'alpha',
            sessions: [
                { id: 'alpha', seq: 1, label: 'Alpha session', created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z', message_count: 0 },
                { id: 'beta', seq: 2, label: 'Beta session', created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z', message_count: 0 },
            ],
        },
    }));
    await page.route('**/i/3506/api/messages?**', route => json(route, {
        ok: true,
        data: [],
        pageInfo: { oldestCursor: null, newestCursor: null, hasMoreBefore: false, limit: 100 },
        snapshotEventSeq: 0,
    }));
    await page.route('**/i/3506/api/message', async route => {
        const body = route.request().postDataJSON() as { prompt?: string };
        sent.push(body.prompt ?? '');
        await json(route, { ok: true });
    });
    await page.route('**/i/3506/api/orchestrate/snapshot', route => json(route, { queued: [] }));
    await page.route('**/i/3506/api/settings', route => json(route, {
        ok: true,
        data: { cli: 'codex', perCli: { codex: { provider: 'openai', model: 'gpt-5', effort: 'medium' } }, activeOverrides: {} },
    }));
    await page.route('**/i/3506/api/cli-registry', route => json(route, {
        ok: true,
        data: { codex: { defaultProvider: 'openai', defaultModel: 'gpt-5', defaultEffort: 'medium', providers: ['openai'], models: ['gpt-5'], efforts: ['medium'] } },
    }));
    await page.route('**/api/browser/**', route => json(route, { ok: true }));
}

async function activeElement(page: Page): Promise<{ name: string; tag: string; className: string }> {
    return page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element) return { name: '', tag: '', className: '' };
        const name = element.getAttribute('aria-label')
            || element.getAttribute('title')
            || element.textContent?.replace(/\s+/g, ' ').trim()
            || '';
        return { name, tag: element.tagName.toLowerCase(), className: element.className };
    });
}

async function tabTo(page: Page, label: RegExp, limit = 80): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
        await page.keyboard.press('Tab');
        const active = await activeElement(page);
        if (label.test(active.name)) return;
    }
    const active = await activeElement(page);
    throw new Error(`Keyboard focus did not reach ${label}; stopped on ${active.tag} ${active.name}`);
}

async function keyboardCoreFlow(page: Page, viewportWidth: number, sent: string[]): Promise<string[]> {
    const focusOrder: string[] = [];
    if (viewportWidth < 1024) {
        await tabTo(page, /^Open sidebar$/);
        focusOrder.push((await activeElement(page)).name);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Close sidebar' }).waitFor();
    }
    await tabTo(page, /^A11y fixture.*3506/);
    focusOrder.push((await activeElement(page)).name);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /Alpha session/ }).waitFor();

    await tabTo(page, /Alpha session/);
    focusOrder.push((await activeElement(page)).name);
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Message' }).waitFor();

    if (viewportWidth < 1024) {
        await tabTo(page, /^Close sidebar$/);
        focusOrder.push((await activeElement(page)).name);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Open sidebar' }).waitFor();
    }

    await tabTo(page, /^Message$/);
    focusOrder.push((await activeElement(page)).name);
    await page.keyboard.type('Keyboard-only a11y gate');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value === '');
    assert.equal(sent.at(-1), 'Keyboard-only a11y gate');

    await tabTo(page, /^Open side pane$/);
    const paneTrigger = await activeElement(page);
    assert.match(paneTrigger.className, /d2-workbench-side-toggle/, 'keyboard reached the workbench pane trigger');
    focusOrder.push(paneTrigger.name);
    await page.keyboard.press('Enter');
    await page.locator('.d2-workbench-side-open').waitFor();
    try {
        await page.getByRole('heading', { name: 'Open panel' }).waitFor({ timeout: 3_000 });
    } catch {
        const state = await page.evaluate(() => ({
            shell: document.querySelector('.d2-shell')?.className,
            workbench: document.querySelector('.d2-workbench')?.className,
            slotDisplay: getComputedStyle(document.querySelector('.d2-workbench-side-pane-slot')!).display,
            pickerDisplay: getComputedStyle(document.querySelector('.d2-side-pane-picker')!).display,
        }));
        throw new Error(`side-pane picker is not visible at ${viewportWidth}px: ${JSON.stringify(state)}`);
    }
    await tabTo(page, /^Browser$/);
    focusOrder.push((await activeElement(page)).name);
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: 'Browser', exact: true }).waitFor();

    await tabTo(page, /^Close side pane$/);
    focusOrder.push((await activeElement(page)).name);
    await page.keyboard.press('Enter');
    await page.locator('.d2-side-pane').waitFor({ state: 'hidden' });
    const restored = await activeElement(page);
    assert.equal(restored.name, 'Open side pane', 'closing the pane restores focus to its trigger');
    focusOrder.push(restored.name);
    return focusOrder;
}

async function axeScan(page: Page): Promise<AxeViolationEvidence[]> {
    await page.addScriptTag({ content: axe.source });
    return page.evaluate(async () => {
        const result = await (window as typeof window & {
            axe: { run(context: Document, options: object): Promise<{ violations: AxeViolationEvidence[] }> };
        }).axe.run(document, { resultTypes: ['violations'] });
        return result.violations;
    });
}

async function reducedMotionSpotCheck(page: Page): Promise<Record<string, { animationName: string; animationDuration: string; stopped: boolean }>> {
    return page.evaluate(() => {
        const host = document.createElement('div');
        host.className = 'd2-shell';
        host.innerHTML = '<span class="d2-spinner"></span><div class="d2-turn-shimmer"><span class="d2-segment-label">Working</span></div><div class="d2-composer-pill" data-phase="P"></div>';
        document.body.append(host);
        const selectors = { spinner: '.d2-spinner', shimmer: '.d2-segment-label', glow: '.d2-composer-pill' };
        const result = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
            const style = getComputedStyle(host.querySelector(selector)!);
            const seconds = style.animationDuration.split(',').map(value => Number.parseFloat(value) * (value.includes('ms') ? 0.001 : 1));
            return [name, {
                animationName: style.animationName,
                animationDuration: style.animationDuration,
                stopped: style.animationName === 'none' || seconds.every(value => value <= 0.02),
            }];
        }));
        host.remove();
        return result;
    });
}

test('090 dashboard2 axe, keyboard, contrast, and reduced-motion hard gate', { timeout: 360_000 }, async () => {
    const browser = await launchBrowser();
    const origin = await startVite();
    const runs: Array<Record<string, unknown>> = [];
    let contrast: ContrastEvidence[] = [];

    for (const theme of THEMES) {
        for (const viewport of VIEWPORTS) {
            const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
            contexts.push(context);
            const page = await context.newPage();
            const sent: string[] = [];
            await page.addInitScript((selectedTheme) => {
                Object.defineProperty(window, '__name', { configurable: true, value: (fn: unknown) => fn });
                localStorage.clear();
                localStorage.setItem('jaw.uiTheme', selectedTheme);
                class NoopEventSource {
                    onmessage: ((event: MessageEvent) => void) | null = null;
                    onerror: (() => void) | null = null;
                    close(): void { /* deterministic a11y fixture */ }
                }
                Object.defineProperty(window, 'EventSource', { configurable: true, value: NoopEventSource });
            }, theme);
            await installRoutes(page, theme, sent);
            await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
            await page.evaluate('globalThis.__name = globalThis.__name || ((fn) => fn)');
            await page.locator('.d2-shell').waitFor();
            await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);

            const focusOrder = await keyboardCoreFlow(page, viewport.width, sent);
            const violations = await axeScan(page);
            const motion = await reducedMotionSpotCheck(page);
            const runContrast = await collectContrastTable(page, theme);
            if (viewport.width === VIEWPORTS[0].width) contrast = [...contrast, ...runContrast];
            runs.push({ theme, viewport, focusOrder, sentMessages: sent.length, violations, reducedMotion: motion });
        }
    }

    const severityCounts = Object.fromEntries(['minor', 'moderate', 'serious', 'critical'].map(impact => [
        impact,
        runs.reduce((sum, run) => sum + (run.violations as AxeViolationEvidence[]).filter(item => item.impact === impact).length, 0),
    ]));
    const externalIframeExceptions = runs.flatMap(run => (run.violations as AxeViolationEvidence[]).filter(violation => (
        violation.impact === 'moderate'
        && violation.nodes.every(node => node.target.some(target => /iframe/.test(target)))
    )));
    const disallowedModerate = runs.flatMap(run => (run.violations as AxeViolationEvidence[]).filter(violation => (
        violation.impact === 'moderate' && !externalIframeExceptions.includes(violation)
    )));
    const evidence = {
        schemaVersion: 1,
        gate: '090-dashboard2-a11y',
        generatedAt: new Date().toISOString(),
        baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
        sourceUnderTest: 'working-tree',
        command: 'npx tsx --test tests/browser/dashboard2-a11y.test.ts',
        thresholds: { normalText: 4.5, largeTextAndUi: 3, axeBlockedImpacts: ['serious', 'critical'], moderatePolicy: 'external iframe boundaries only' },
        summary: { severityCounts, runs: runs.length, keyboardFlowsPassed: runs.length, contrastRows: contrast.length, contrastFailures: contrast.filter(row => !row.pass).length },
        externalIframeExceptions,
        runs,
        contrast,
    };
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

    assert.equal(Number(severityCounts['serious']), 0, 'axe serious violations');
    assert.equal(Number(severityCounts['critical']), 0, 'axe critical violations');
    assert.deepEqual(disallowedModerate, [], 'axe moderate violations are allowed only at explicit external iframe boundaries');
    assert.deepEqual(contrast.filter(row => !row.pass), [], 'all recorded token/surface pairs meet their WCAG AA threshold');
    for (const run of runs) {
        assert.equal(Object.values(run.reducedMotion as Record<string, { stopped: boolean }>).every(item => item.stopped), true);
    }
});
