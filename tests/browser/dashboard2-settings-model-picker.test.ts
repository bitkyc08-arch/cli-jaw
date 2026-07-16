import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SECRET = 'SECRET_CANARY_SETTINGS_BROWSER_9d10';
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launch(t: TestContext): Promise<Browser | null> {
    for (const attempt of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try {
            const browser = await attempt();
            browsers.push(browser);
            return browser;
        } catch { /* local fallback */ }
    }
    t.skip('no local Chrome/Chromium');
    return null;
}

test('Settings opens Display, Agent, and Model Provider with exact JSON contracts and no secret exposure', { timeout: 120_000 }, async t => {
    const browser = await launch(t);
    if (!browser) return;
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
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    contexts.push(context);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => consoleErrors.push(error.message));
    await page.route('**/api/dashboard/registry', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ registry: { ui: { uiTheme: 'dark', locale: 'en', fontSize: 14 } }, status: { source: 'disk' } }),
    }));
    await page.route('**/i/3506/api/settings', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
            ok: true,
            data: {
                cli: 'codex',
                perCli: { codex: { model: 'gpt-5.5', effort: 'medium', apiKey: SECRET } },
                activeOverrides: { codex: { model: 'gpt-5.6-sol', effort: 'high', token: SECRET } },
                telegram: { botToken: SECRET },
            },
        }),
    }));
    await page.route('**/i/3506/api/cli-registry', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
            ok: true,
            data: { codex: { defaultModel: 'gpt-5.5', models: ['gpt-5.5', 'gpt-5.6-sol'], efforts: ['medium', 'high'], registryToken: SECRET } },
        }),
    }));
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        class NoopEventSource {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: (() => void) | null = null;
            close(): void { /* noop */ }
        }
        Object.defineProperty(window, 'EventSource', { configurable: true, value: NoopEventSource });
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/dev/settings-harness.tsx');
        module.mountSettingsHarness(target);
    });

    await page.waitForTimeout(100);
    if (await page.getByRole('heading', { name: 'Display' }).count() === 0) {
        throw new Error(`Settings harness failed to render: ${consoleErrors.join(' | ')} :: ${await page.locator('#dashboard2-root').innerText()}`);
    }
    await page.getByRole('heading', { name: 'Display' }).waitFor();
    await page.getByRole('button', { name: /Agent/ }).click();
    await page.getByRole('heading', { name: 'Agent defaults' }).waitFor();
    await page.getByText('An active worker-wide override currently masks this default in Chat.').waitFor();
    assert.equal(await page.getByRole('combobox', { name: /Default provider and model/ }).isEnabled(), true);

    await page.getByRole('button', { name: /Model providers/ }).click();
    await page.getByRole('heading', { name: 'Model providers' }).waitFor();
    const providerPicker = page.getByRole('combobox', { name: /Default provider and model/ });
    await providerPicker.waitFor();
    await assert.doesNotReject(() => providerPicker.click({ trial: true }));
    assert.equal(await providerPicker.isEnabled(), true);
    assert.equal((await page.locator('body').innerText()).includes(SECRET), false);
    assert.equal(consoleErrors.some(message => message.includes(SECRET)), false);
    assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
});
