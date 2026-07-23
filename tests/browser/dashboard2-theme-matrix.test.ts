import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EVIDENCE_PATH = join(ROOT, 'refs', '092-theme-evidence.json');
const BASELINE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const THEMES = ['dark', 'light'] as const;
const PANEL_WIDTHS = [280, 500, 700] as const;
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];

const EXPECTED = {
    dark: {
        bg: 'rgb(13, 13, 15)', surface: 'rgb(26, 26, 29)', surfaceH: 'rgb(34, 34, 37)',
        text: 'rgb(240, 240, 242)', text2: 'rgb(176, 176, 184)', border: 'rgba(255, 255, 255, 0.06)',
        focus: 'rgb(110, 168, 254)', positive: 'rgb(91, 216, 138)', warn: 'rgb(229, 185, 79)', danger: 'rgb(248, 113, 113)',
    },
    light: {
        bg: 'rgb(245, 247, 250)', surface: 'rgb(255, 255, 255)', surfaceH: 'rgb(238, 241, 245)',
        text: 'rgb(24, 32, 42)', text2: 'rgb(61, 72, 84)', border: 'rgba(0, 0, 0, 0.08)',
        focus: 'rgb(9, 105, 218)', positive: 'rgb(22, 121, 75)', warn: 'rgb(154, 103, 0)', danger: 'rgb(180, 35, 24)',
    },
} as const;

const PHASE_RGB = {
    I: 'rgba(192, 132, 252, 0.45)', P: 'rgba(122, 162, 247, 0.45)', A: 'rgba(251, 191, 36, 0.45)',
    B: 'rgba(74, 222, 128, 0.45)', C: 'rgba(251, 146, 60, 0.45)', D: 'rgba(34, 211, 238, 0.45)',
} as const;

after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launchBrowser(): Promise<Browser> {
    for (const launch of [() => chromium.launch({ headless: true, channel: 'chrome' as const }), () => chromium.launch({ headless: true })]) {
        try { const browser = await launch(); browsers.push(browser); return browser; } catch { /* local fallback */ }
    }
    throw new Error('092 theme matrix requires a local Chrome/Chromium executable');
}

async function startVite(): Promise<string> {
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen();
    servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('Vite failed to bind');
    return `http://127.0.0.1:${address.port}`;
}

async function openHarness(browser: Browser, origin: string, colorScheme: 'dark' | 'light'): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme });
    contexts.push(context);
    const page = await context.newPage();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const module = await import('/dist/dashboard2/src/dev/theme-evidence-harness.ts');
        module.mountThemeEvidenceHarness(document.querySelector<HTMLElement>('#dashboard2-root')!);
    });
    await page.getByTestId('panel').waitFor();
    return page;
}

async function tokenSnapshot(page: Page, theme: 'dark' | 'light' | 'auto'): Promise<Record<string, unknown>> {
    await page.evaluate(selected => { document.documentElement.dataset.theme = selected; }, theme);
    return page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const value = (name: string) => {
            const probe = document.createElement('span');
            probe.style.color = `var(${name})`;
            document.body.append(probe);
            const resolved = getComputedStyle(probe).color;
            probe.remove();
            return resolved;
        };
        const glass = getComputedStyle(document.querySelector('[data-testid="glass"]')!, '::before');
        const phases = Object.fromEntries(['I', 'P', 'A', 'B', 'C', 'D'].map(phase => {
            const style = getComputedStyle(document.querySelector(`[data-testid="phase-${phase}"]`)!);
            return [phase, { borderColor: style.borderColor, boxShadow: style.boxShadow }];
        }));
        return {
            bg: value('--bg'), surface: value('--surface'), surfaceH: value('--surface-h'), text: value('--text'), text2: value('--text-2'),
            border: value('--border'), focus: value('--accent'), positive: value('--positive'), warn: value('--warn'), danger: value('--danger'),
            glass: { backdropFilter: glass.backdropFilter, backgroundImage: glass.backgroundImage }, phases,
        };
    });
}

test('092 dark/light/auto tokens and panel widths resolve without visual loss', { timeout: 240_000 }, async () => {
    const browser = await launchBrowser();
    const origin = await startVite();
    const runs: Array<Record<string, unknown>> = [];

    for (const theme of THEMES) {
        const page = await openHarness(browser, origin, theme);
        const tokens = await tokenSnapshot(page, theme);
        for (const [name, expected] of Object.entries(EXPECTED[theme])) assert.equal(tokens[name], expected, `${theme} ${name}`);
        assert.equal((tokens.glass as { backdropFilter: string }).backdropFilter, 'blur(48px) saturate(1.3)');
        for (const [phase, expected] of Object.entries(PHASE_RGB)) {
            assert.equal((tokens.phases as Record<string, { borderColor: string }>)[phase]?.borderColor, expected, `${theme} phase ${phase}`);
        }
        for (const width of PANEL_WIDTHS) {
            const smoke = await page.evaluate(panelWidth => {
                document.documentElement.style.setProperty('--evidence-panel-width', `${panelWidth}px`);
                const panel = document.querySelector<HTMLElement>('[data-testid="panel"]')!;
                const text = document.querySelector<HTMLElement>('[data-testid="secondary"]')!;
                const panelStyle = getComputedStyle(panel);
                const textStyle = getComputedStyle(text);
                const rect = panel.getBoundingClientRect();
                return {
                    requestedWidth: panelWidth, actualWidth: rect.width,
                    overflowX: panel.scrollWidth - panel.clientWidth,
                    textVisible: textStyle.visibility !== 'hidden' && textStyle.opacity !== '0' && textStyle.color !== panelStyle.backgroundColor,
                    contained: rect.right <= innerWidth && rect.left >= 0,
                };
            }, width);
            assert.ok(Math.abs(smoke.actualWidth - width) < 1, `${theme}/${width}: panel width`);
            assert.ok(smoke.overflowX <= 0, `${theme}/${width}: horizontal overflow ${smoke.overflowX}`);
            assert.equal(smoke.textVisible, true, `${theme}/${width}: text visible`);
            assert.equal(smoke.contained, true, `${theme}/${width}: panel contained`);
            runs.push({ theme, panelWidth: width, ...smoke, pass: true });
        }
        await page.close();
    }

    const auto: Record<string, unknown> = {};
    for (const system of THEMES) {
        const page = await openHarness(browser, origin, system);
        const snapshot = await tokenSnapshot(page, 'auto');
        for (const [name, expected] of Object.entries(EXPECTED[system])) assert.equal(snapshot[name], expected, `auto/${system} ${name}`);
        auto[system] = snapshot;
        await page.close();
    }
    assert.notDeepEqual(EXPECTED.dark, EXPECTED.light, 'dark and light semantic sets must remain distinct');
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify({ schemaVersion: 1, suite: 'dashboard2-theme-matrix', baselineSha: BASELINE_SHA, sidebarBlurDecision: 'as-built 48px saturate(1.3)', tokens: { dark: EXPECTED.dark, light: EXPECTED.light, auto }, panelMatrix: runs, failures: [], pass: true }, null, 2)}\n`);
});
