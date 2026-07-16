import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function openHarness(t: TestContext): Promise<Page | null> {
    let browser: Browser | null = null;
    for (const launch of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try { browser = await launch(); break; } catch { /* try local fallback */ }
    }
    if (!browser) { t.skip('no local Chrome/Chromium'); return null; }
    browsers.push(browser);
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
    if (!address || typeof address !== 'object') throw new Error('vite bind failed');
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    contexts.push(context);
    const page = await context.newPage();
    const runtimeErrors: string[] = [];
    page.on('dialog', dialog => void dialog.accept());
    page.on('pageerror', error => runtimeErrors.push(`pageerror: ${error.message}`));
    page.on('console', entry => {
        if (entry.type() === 'error') runtimeErrors.push(`console: ${entry.text()}`);
    });
    await page.addInitScript(() => {
        class QuietEventSource {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: (() => void) | null = null;
            constructor(readonly url: string) {}
            close(): void {}
        }
        Object.defineProperty(window, 'EventSource', { configurable: true, value: QuietEventSource });
        Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    });
    let status: 'online' | 'offline' = 'offline';
    let pollCount = 0;
    let lifecyclePosts = 0;
    const instance = () => ({
        port: 3457, url: 'http://127.0.0.1:3457', status, ok: status === 'online',
        version: status === 'online' ? '2.2.7' : null, uptime: null, instanceId: null,
        homeDisplay: '~/.cli-jaw', workingDir: '/tmp/lifecycle-browser', projectDirs: ['/tmp/lifecycle-browser'],
        currentCli: status === 'online' ? 'codex' : null, currentModel: null, serviceMode: 'ad-hoc',
        label: 'Lifecycle test', lastCheckedAt: new Date().toISOString(), healthReason: null,
        lifecycle: {
            owner: status === 'online' ? 'manager' : 'none', canStart: status === 'offline',
            canStop: status === 'online', canRestart: status === 'online', canPerm: status === 'online', canUnperm: false,
            reason: 'browser fixture', defaultHome: '/tmp/lifecycle-browser', commandPreview: ['jaw', 'serve'],
            pid: status === 'online' ? 4321 : null,
        },
    });
    await page.route('**/api/dashboard/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === '/api/dashboard/instances/3457') {
            pollCount += 1;
            if (lifecyclePosts === 1 && pollCount >= 2) status = 'online';
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, instance: instance(), platform: 'darwin' }) });
        }
        if (path === '/api/dashboard/instances') {
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ manager: {}, instances: [instance()], peerDashboards: [], platform: 'darwin' }) });
        }
        if (path === '/api/dashboard/lifecycle/start') {
            lifecyclePosts += 1;
            pollCount = 0;
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
                ok: true, action: 'start', port: 3457, status: 'started', message: 'started', home: '/tmp/lifecycle-browser',
                pid: 4321, command: ['jaw', 'serve'], expectedStateAfter: 'online',
            }) });
        }
        if (path === '/api/dashboard/lifecycle/stop') {
            lifecyclePosts += 1;
            status = 'offline';
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
                ok: true, action: 'stop', port: 3457, status: 'stopped', message: 'stopped', home: '/tmp/lifecycle-browser',
                pid: null, command: ['jaw', 'serve'], expectedStateAfter: 'offline',
            }) });
        }
        return route.abort();
    });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/dev/lifecycle-convergence-harness.tsx');
        module.mountLifecycleConvergenceHarness(target);
    });
    try {
        await page.getByRole('button', { name: 'Start Lifecycle test' }).waitFor();
    } catch (error) {
        throw new Error(`lifecycle harness did not render: ${runtimeErrors.join(' | ')} body=${(await page.locator('body').innerText()).slice(0, 500)}`, { cause: error });
    }
    return page;
}

test('dashboard2 lifecycle is visible, keyboard operable, convergent, and announced', { timeout: 240_000 }, async t => {
    const page = await openHarness(t);
    if (!page) return;
    const start = page.getByRole('button', { name: 'Start Lifecycle test' });
    const style = await start.evaluate(element => {
        const computed = getComputedStyle(element);
        return { opacity: computed.opacity, visibility: computed.visibility, pointerEvents: computed.pointerEvents };
    });
    assert.deepEqual(style, { opacity: '1', visibility: 'visible', pointerEvents: 'auto' });

    for (let index = 0; index < 20; index += 1) {
        if (await start.evaluate(element => document.activeElement === element)) break;
        await page.keyboard.press('Tab');
    }
    assert.equal(await start.evaluate(element => document.activeElement === element), true, 'Start must be Tab reachable');
    await page.keyboard.press('Enter');
    await page.getByRole('status').waitFor();
    await page.getByRole('button', { name: 'Stop Lifecycle test' }).waitFor({ timeout: 10_000 });

    const stop = page.getByRole('button', { name: 'Stop Lifecycle test' });
    await stop.focus();
    assert.equal(await stop.evaluate(element => document.activeElement === element), true, 'Stop must be focusable');
    await stop.press('Space');
    await page.getByRole('button', { name: 'Start Lifecycle test' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[role="alert"]').count(), 0);
    await page.screenshot({ path: join(ROOT, '.codexclaw/evidence/wp3-lifecycle-browser.png') });
});
