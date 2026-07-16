import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launchChromium(t: TestContext): Promise<Browser | null> {
    const attempts = [
        () => chromium.launch({ headless: true, channel: 'chrome' }),
        () => chromium.launch({ headless: true }),
    ];
    for (const attempt of attempts) {
        try {
            const browser = await attempt();
            browsers.push(browser);
            return browser;
        } catch { /* try the next locally installed executable */ }
    }
    t.skip('no local Chrome/Chromium executable for dashboard2 composer structure');
    return null;
}

test('046 browser structure: one 25px squircle and ordered controls', async t => {
    const source = readFileSync(resolve(ROOT, 'public/dashboard2/src/chat/composer/ComposerFooter.tsx'), 'utf8');
    const css = readFileSync(resolve(ROOT, 'public/dashboard2/src/chat/composer/composer.css'), 'utf8');
    assert.match(css, /\.d2-composer-pill\s*\{[^}]*border-radius:\s*25px/s);
    assert.match(css, /corner-shape:\s*superellipse\(1\.5\)/);
    assert.ok(source.indexOf('onAttach') < source.indexOf('Full access'));
    assert.ok(source.indexOf('d2-composer-picker') < source.indexOf('Start voice input'));
    assert.ok(source.indexOf('Start voice input') < source.indexOf('Send message'));
    assert.match(source, /props\.goalLabel \?/);

    const browser = await launchChromium(t);
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
    await page.setContent(`<style>${css}</style><div class="d2-composer-wrap"><div class="d2-composer-pill" data-testid="pill"><textarea>Message</textarea><div class="d2-composer-footer"><div class="d2-composer-controls"><button class="d2-composer-icon">+</button><button class="d2-composer-access">Full access</button></div><div class="d2-composer-controls"><button class="d2-composer-picker">claude · opus Ultra</button><button class="d2-composer-icon">mic</button><button class="d2-composer-icon d2-composer-primary">send</button></div></div></div></div>`);
    const metrics = await page.locator('[data-testid="pill"]').evaluate(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { radius: style.borderRadius, width: rect.width, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(metrics.radius, '25px');
    assert.ok(metrics.width <= 700);
    assert.equal(metrics.overflow, false);
});

test('WP4 real React composer enables model selection and sends through its explicit worker port', { timeout: 120_000 }, async t => {
    const browser = await launchChromium(t);
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
    const context = await browser.newContext({ viewport: { width: 900, height: 520 } });
    contexts.push(context);
    const page = await context.newPage();
    const sent: Array<{ url: string; body: unknown }> = [];
    await page.route('**/i/**', async route => {
        const request = route.request();
        sent.push({ url: request.url(), body: request.postDataJSON() as unknown });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, action: 'started' }),
        });
    });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/dev/composer-harness.tsx');
        module.mountComposerHarness(target);
    });

    const picker = page.getByRole('combobox', { name: /Provider and model/ });
    await picker.waitFor();
    assert.equal(await picker.isEnabled(), true);
    assert.match(await picker.getAttribute('title') ?? '', /every Chat session/);
    await picker.click();
    await page.getByRole('option', { name: /gpt-5\.6-sol/ }).click();
    await page.waitForFunction(() => document.querySelector('main[data-selected]')?.getAttribute('data-selected') === 'codex:gpt-5.6-sol');
    assert.equal(await page.locator('main[data-selected]').getAttribute('data-selected'), 'codex:gpt-5.6-sol');

    await page.getByRole('textbox', { name: 'Message' }).fill('WP4 composer send');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-echo-status') === 'sent');
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.url, /\/i\/3506\/api\/message$/);
    assert.deepEqual(sent[0]!.body, { prompt: 'WP4 composer send' });
});
