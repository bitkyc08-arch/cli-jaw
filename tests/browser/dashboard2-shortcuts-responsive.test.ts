import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EVIDENCE_PATH = join(ROOT, 'refs', '093-shortcuts-evidence.json');
const BASELINE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const VIEWPORTS = [
    { width: 1440, height: 900, orientation: 'landscape' },
    { width: 1280, height: 720, orientation: 'landscape' },
    { width: 1024, height: 768, orientation: 'landscape' },
    { width: 768, height: 1024, orientation: 'portrait' },
    { width: 720, height: 900, orientation: 'portrait' },
] as const;
const SURFACES = ['composer', 'notes-editable', 'settings-field', 'xterm-terminal', 'browser-url', 'iframe-focus', 'code-history', 'code-composer', 'code-permission'] as const;
type Surface = typeof SURFACES[number];
type Collision = { cmdN: 'allowed' | 'suppressed'; cmdK: 'allowed' | 'suppressed'; cmdW: 'allowed' | 'suppressed' };

const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launchBrowser(): Promise<Browser> {
    for (const launch of [() => chromium.launch({ headless: true, channel: 'chrome' as const }), () => chromium.launch({ headless: true })]) {
        try { const browser = await launch(); browsers.push(browser); return browser; } catch { /* local fallback */ }
    }
    throw new Error('093 shortcuts/responsive matrix requires a local Chrome/Chromium executable');
}

async function startVite(): Promise<string> {
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen(); servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('Vite failed to bind');
    return `http://127.0.0.1:${address.port}`;
}

function json(route: Route, body: unknown): Promise<void> {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function installAppRoutes(page: Page): Promise<void> {
    const ui = { uiTheme: 'dark', locale: 'en', dashboardShortcutsEnabled: true, dashboardShortcutKeymap: { focusNotes: 'Meta+N', focusInstances: 'Meta+K' }, chatLinkPreviewsEnabled: false };
    await page.route('**/api/dashboard/**', route => json(route, { ok: true, data: [], items: [] }));
    await page.route('**/api/browser/**', route => json(route, { ok: true, tabs: [], data: [] }));
    await page.route('**/i/**', route => json(route, { ok: true, data: [], sessions: [] }));
    await page.route('**/api/dashboard/instances', route => json(route, { manager: null, peerDashboards: [], platform: 'darwin', instances: [] }));
    await page.route('**/api/dashboard/registry', route => json(route, { registry: { ui }, status: {} }));
}

async function openRealApp(browser: Browser, origin: string, viewport: { width: number; height: number }): Promise<Page> {
    const context = await browser.newContext({ viewport });
    contexts.push(context);
    const page = await context.newPage();
    const runtimeErrors: string[] = [];
    page.on('pageerror', error => runtimeErrors.push(`pageerror: ${error.message}`));
    page.on('console', entry => { if (entry.type() === 'error') runtimeErrors.push(`console: ${entry.text()}`); });
    await page.addInitScript(() => {
        Object.defineProperty(window, '__name', { configurable: true, value: (fn: unknown) => fn });
        localStorage.clear();
        localStorage.setItem('jaw.uiTheme', 'dark');
        class QuietEventSource { onmessage = null; onerror = null; constructor(readonly url: string) {} close(): void {} }
        Object.defineProperty(window, 'EventSource', { configurable: true, value: QuietEventSource });
        Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    });
    await installAppRoutes(page);
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    try {
        await page.locator('.d2-shell').waitFor({ timeout: 8_000 });
    } catch (error) {
        throw new Error(`dashboard2 app did not render: ${runtimeErrors.join(' | ')} body=${(await page.locator('body').innerText()).slice(0, 500)}`, { cause: error });
    }
    return page;
}

async function populateOverflowPanels(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Open side pane' }).click();
    await page.locator('.d2-side-pane').waitFor();
    for (const panel of ['terminal', 'browser', 'files', 'code', 'doc', 'design', 'diff', 'notes']) {
        await page.locator(`.d2-side-pane-picker-button[data-tab="${panel}"]`).click();
        if (panel !== 'notes') await page.getByRole('button', { name: 'Open panel', exact: true }).click();
    }
    await page.locator('.d2-side-pane-overflow-trigger').waitFor();
}

async function collectProviderCollisions(browser: Browser, origin: string): Promise<{ matrix: Record<Surface, Pick<Collision, 'cmdN' | 'cmdK'>>; imeGuard: boolean }> {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const module = await import('/dist/dashboard2/src/dev/shortcut-evidence-harness.tsx');
        module.mountShortcutEvidenceHarness(document.querySelector<HTMLElement>('#dashboard2-root')!);
    });
    await page.getByTestId('shortcut-harness').waitFor();

    async function dispatch(surface: string, key: 'n' | 'k', composing = false): Promise<boolean> {
        return page.evaluate(({ selectedSurface, selectedKey, isComposing }) => {
            const selector = `[data-surface="${selectedSurface}"]`;
            if (selectedSurface === 'iframe-focus') {
                const frame = document.querySelector<HTMLIFrameElement>('[data-surface="iframe"]')!;
                const target = frame.contentDocument!.querySelector<HTMLElement>('#frame-target')!;
                const event = new frame.contentWindow!.KeyboardEvent('keydown', { key: selectedKey, metaKey: true, bubbles: true, cancelable: true });
                target.dispatchEvent(event);
                return event.defaultPrevented;
            }
            const target = document.querySelector<HTMLElement>(selector)!;
            target.focus();
            const before = { ...window.__jawShortcutEvidence!.counts };
            const event = new KeyboardEvent('keydown', { key: selectedKey, code: `Key${selectedKey.toUpperCase()}`, metaKey: true, bubbles: true, cancelable: true });
            if (isComposing) Object.defineProperty(event, 'isComposing', { value: true });
            target.dispatchEvent(event);
            const action = selectedKey === 'n' ? 'focusNotes' : 'focusInstances';
            return window.__jawShortcutEvidence!.counts[action] > before[action];
        }, { selectedSurface: surface, selectedKey: key, isComposing: composing });
    }

    const matrix = {} as Record<Surface, Pick<Collision, 'cmdN' | 'cmdK'>>;
    for (const surface of SURFACES) {
        matrix[surface] = { cmdN: await dispatch(surface, 'n') ? 'allowed' : 'suppressed', cmdK: await dispatch(surface, 'k') ? 'allowed' : 'suppressed' };
    }
    const before = await page.evaluate(() => window.__jawShortcutEvidence!.counts.focusNotes);
    await dispatch('code-history', 'n', true);
    const afterIme = await page.evaluate(() => window.__jawShortcutEvidence!.counts.focusNotes);
    await context.close();
    return { matrix, imeGuard: before === afterIme };
}

async function collectCmdW(page: Page): Promise<Record<Surface, Collision['cmdW']>> {
    const result = {} as Record<Surface, Collision['cmdW']>;
    if (!await page.locator('.d2-side-pane').isVisible()) await page.getByRole('button', { name: 'Open side pane' }).click();
    await page.locator('.d2-side-pane').waitFor();
    for (const surface of SURFACES) {
        const panelCountBefore = await page.locator('.d2-side-pane-tab-slot').count();
        result[surface] = await page.evaluate(selectedSurface => {
            if (selectedSurface === 'iframe-focus') {
                const frame = document.createElement('iframe');
                return new Promise<'allowed' | 'suppressed'>(resolve => {
                    frame.addEventListener('load', () => {
                        const event = new frame.contentWindow!.KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true });
                        frame.contentDocument!.querySelector<HTMLElement>('#target')!.dispatchEvent(event);
                        frame.remove();
                        resolve(event.defaultPrevented ? 'allowed' : 'suppressed');
                    }, { once: true });
                    frame.srcdoc = '<button id="target">frame</button>';
                    document.body.append(frame);
                });
            }
            const codeSurface = selectedSurface.startsWith('code-');
            const host = codeSurface ? document.querySelector<HTMLElement>('.d2-side-pane')! : document.body;
            const editable = ['composer', 'notes-editable', 'settings-field', 'browser-url', 'code-composer'].includes(selectedSurface);
            const target = editable ? document.createElement(selectedSurface === 'notes-editable' ? 'div' : selectedSurface.includes('composer') ? 'textarea' : 'input') : document.createElement('button');
            if (selectedSurface === 'notes-editable') target.contentEditable = 'true';
            if (selectedSurface === 'xterm-terminal') target.className = 'xterm';
            host.append(target); target.focus();
            const event = new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true });
            target.dispatchEvent(event); target.remove();
            return event.defaultPrevented ? 'allowed' : 'suppressed';
        }, surface);
        if (surface.startsWith('code-')) {
            await page.waitForFunction(expected => document.querySelectorAll('.d2-side-pane-tab-slot').length === expected, panelCountBefore - 1);
        }
    }
    return result;
}

test('093 browser shortcut collision and exact responsive viewport matrix', { timeout: 300_000 }, async () => {
    const browser = await launchBrowser();
    const origin = await startVite();
    const provider = await collectProviderCollisions(browser, origin);
    assert.equal(provider.imeGuard, true, 'IME composition must suppress global shortcuts');

    const viewportEvidence: Array<Record<string, unknown>> = [];
    let cmdW: Record<Surface, Collision['cmdW']> | null = null;
    const page = await openRealApp(browser, origin, VIEWPORTS[0]);
    await populateOverflowPanels(page);
    for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await page.waitForFunction(expected => document.querySelector('.d2-shell')?.classList.contains('d2-sb-closed') === expected, viewport.width < 1024);
        const responsive = await page.evaluate(() => ({
            sidebarCollapsed: document.querySelector('.d2-shell')?.classList.contains('d2-sb-closed') ?? false,
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
            bodyOverflow: document.body.scrollWidth - innerWidth,
        }));
        assert.equal(responsive.sidebarCollapsed, viewport.width < 1024, `${viewport.width}x${viewport.height}: sidebar collapse`);
        assert.ok(responsive.documentOverflow <= 0, `${viewport.width}x${viewport.height}: document overflow`);
        assert.ok(responsive.bodyOverflow <= 0, `${viewport.width}x${viewport.height}: body overflow`);
        const overflow = page.locator('.d2-side-pane-overflow-trigger');
        try {
            await overflow.waitFor({ timeout: 8_000 });
        } catch (error) {
            const state = await page.evaluate(() => ({
                tabs: document.querySelectorAll('.d2-side-pane-tab-slot').length,
                storage: localStorage.getItem('d2.sidepane.v1'),
                paneText: document.querySelector('.d2-side-pane')?.textContent?.slice(0, 300),
            }));
            throw new Error(`overflow trigger missing at ${viewport.width}x${viewport.height}: ${JSON.stringify(state)}`, { cause: error });
        }
        assert.equal(await overflow.getAttribute('title'), '2 more tabs');
        await overflow.click();
        const menu = page.getByRole('menu', { name: 'More tabs' });
        await menu.waitFor();
        assert.equal(await menu.getByRole('menuitem').count(), 8);
        const menuMetrics = await menu.evaluate(element => ({ overflowX: element.scrollWidth - element.clientWidth, visible: getComputedStyle(element).visibility !== 'hidden' }));
        assert.ok(menuMetrics.overflowX <= 0, `${viewport.width}x${viewport.height}: overflow picker horizontal overflow`);
        assert.equal(menuMetrics.visible, true);
        viewportEvidence.push({ ...viewport, ...responsive, overflowPicker: { itemCount: 8, ...menuMetrics }, pass: true });
        await page.keyboard.press('Escape');
    }
    cmdW = await collectCmdW(page);
    await page.context().close();
    assert.ok(cmdW);
    const collisionMatrix = Object.fromEntries(SURFACES.map(surface => [surface, { ...provider.matrix[surface], cmdW: cmdW![surface] }])) as Record<Surface, Collision>;
    const expected: Record<Surface, Collision> = {
        composer: { cmdN: 'suppressed', cmdK: 'suppressed', cmdW: 'suppressed' },
        'notes-editable': { cmdN: 'suppressed', cmdK: 'suppressed', cmdW: 'suppressed' },
        'settings-field': { cmdN: 'suppressed', cmdK: 'suppressed', cmdW: 'suppressed' },
        'xterm-terminal': { cmdN: 'allowed', cmdK: 'suppressed', cmdW: 'suppressed' },
        'browser-url': { cmdN: 'suppressed', cmdK: 'suppressed', cmdW: 'suppressed' },
        'iframe-focus': { cmdN: 'suppressed', cmdK: 'suppressed', cmdW: 'suppressed' },
        'code-history': { cmdN: 'allowed', cmdK: 'allowed', cmdW: 'allowed' },
        'code-composer': { cmdN: 'suppressed', cmdK: 'suppressed', cmdW: 'allowed' },
        'code-permission': { cmdN: 'allowed', cmdK: 'allowed', cmdW: 'allowed' },
    };
    assert.deepEqual(collisionMatrix, expected);
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify({ schemaVersion: 1, suite: 'dashboard2-shortcuts-responsive', baselineSha: BASELINE_SHA, dispatch: { cmdN: 'browser provider', cmdK: 'browser provider', cmdW: 'SidePane DOM handler', imeGuard: provider.imeGuard, electron: 'deferred to WP5' }, collisionMatrix, viewportMatrix: viewportEvidence, failures: [], pass: true }, null, 2)}\n`);
});
