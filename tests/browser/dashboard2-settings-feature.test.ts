import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const largeMessages = Array.from({ length: 10_000 }, (_, index) => ({
    id: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Settings identity fixture row ${index + 1}`,
    cli: 'codex', model: 'gpt-5.5', tool_log: null, trace_run_id: null,
    turn_id: null, cost_usd: null, duration_ms: null, working_dir: '/tmp/settings-fixture',
    created_at: new Date(1_780_000_000_000 + index).toISOString(),
    turn_segments: [],
}));
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
    if (!address || typeof address !== 'object') throw new Error('vite bind failed');
    return `http://127.0.0.1:${address.port}`;
}

async function preparePage(context: BrowserContext, origin: string): Promise<Page> {
    const page = await context.newPage();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({
        contentType: 'application/javascript',
        body: '// settings feature gate stubs app boot',
    }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    return page;
}

function registryBody(ui: Record<string, unknown>): string {
    return JSON.stringify({ registry: { ui }, status: { source: 'disk' } });
}

const workerSettings = {
    cli: 'codex',
    perCli: { codex: { model: 'gpt-5.5', effort: 'medium' } },
    memory: { enabled: true, flushEvery: 10, retentionDays: 30, autoReflectAfterFlush: false },
    network: {
        bindHost: '127.0.0.1',
        lanBypass: false,
        remoteAccess: {
            mode: 'off', trustProxies: false, trustForwardedFor: false,
            publicOriginHint: '', requireAuth: true,
        },
    },
};

async function installSettingsRoutes(page: Page, options: { failWorkerSave?: () => boolean } = {}): Promise<{ workerPuts(): number }> {
    const ui: Record<string, unknown> = { uiTheme: 'dark', locale: 'en' };
    let puts = 0;
    await page.route('**/api/dashboard/registry', async route => {
        if (route.request().method() === 'PATCH') {
            const patch = route.request().postDataJSON() as { ui?: Record<string, unknown> };
            Object.assign(ui, patch.ui ?? {});
        }
        await route.fulfill({ contentType: 'application/json', body: registryBody(ui) });
    });
    await page.route('**/i/3506/api/settings', async route => {
        if (route.request().method() === 'PUT') {
            puts += 1;
            if (options.failWorkerSave?.()) {
                await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'generic failure' }) });
                return;
            }
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: workerSettings }) });
    });
    await page.route('**/i/3506/api/cli-registry', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { codex: { defaultModel: 'gpt-5.5', models: ['gpt-5.5'], efforts: ['medium'] } } }),
    }));
    return { workerPuts: () => puts };
}

async function mountSettings(page: Page): Promise<void> {
    await page.evaluate(async () => {
        class NoopEventSource {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: (() => void) | null = null;
            close(): void { /* noop */ }
        }
        Object.defineProperty(window, 'EventSource', { configurable: true, value: NoopEventSource });
        const module = await import('/dist/dashboard2/src/dev/settings-harness.tsx');
        module.mountSettingsHarness(document.querySelector<HTMLElement>('#dashboard2-root')!);
    });
    await page.getByRole('heading', { name: 'Display' }).waitFor();
}

test('074 validation shows an inline field error, blocks save, and keeps generic server errors in the page toast', { timeout: 120_000 }, async t => {
    const browser = await launch(t);
    if (!browser) return;
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    contexts.push(context);
    const page = await preparePage(context, await startVite());
    let failWorkerSave = false;
    const routes = await installSettingsRoutes(page, { failWorkerSave: () => failWorkerSave });
    await mountSettings(page);

    await page.getByRole('button', { name: /Memory/ }).click();
    await page.getByRole('heading', { name: 'Memory' }).waitFor();
    const flushEvery = page.getByRole('spinbutton', { name: /Flush every/ });
    await flushEvery.fill('0');
    const inlineError = page.getByText('Flush every must be at least 1.');
    await inlineError.waitFor();
    assert.equal(await flushEvery.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Save changes' }).isDisabled(), true);
    assert.equal(routes.workerPuts(), 0, 'invalid draft must not reach worker PUT');

    await flushEvery.fill('20');
    failWorkerSave = true;
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('alert').filter({ hasText: 'Settings request failed (500)' }).waitFor();
    assert.equal(routes.workerPuts(), 1);
});

test('074 settings stays usable at 280/500/700 and supports dirty, save, and discard at each width', { timeout: 120_000 }, async t => {
    const browser = await launch(t);
    if (!browser) return;
    const context = await browser.newContext({ viewport: { width: 700, height: 760 } });
    contexts.push(context);
    const page = await preparePage(context, await startVite());
    await installSettingsRoutes(page);
    await mountSettings(page);

    for (const width of [280, 500, 700]) {
        await page.locator('[data-settings-harness-frame]').evaluate((node, nextWidth) => {
            node.style.width = `${nextWidth}px`;
        }, width);
        const theme = page.getByRole('combobox', { name: /Theme/ });
        const savedTheme = await theme.inputValue() === 'dark' ? 'light' : 'dark';
        await theme.selectOption(savedTheme);
        await page.getByRole('button', { name: 'Save changes' }).click();
        await page.getByText('Display settings saved.').waitFor();
        await theme.selectOption(savedTheme === 'dark' ? 'light' : 'dark');
        await page.getByRole('button', { name: 'Discard' }).click();
        assert.equal(await theme.inputValue(), savedTheme);
        assert.equal(await page.getByRole('button', { name: 'Save changes' }).count(), 0);
        const metrics = await page.evaluate(() => ({
            frameOverflow: (() => {
                const frame = document.querySelector<HTMLElement>('[data-settings-harness-frame]')!;
                return frame.scrollWidth - frame.clientWidth;
            })(),
            pageWidth: document.querySelector<HTMLElement>('.d2-settings-page')?.getBoundingClientRect().width ?? 0,
        }));
        assert.ok(metrics.frameOverflow <= 1, `${width}px settings overflow ${metrics.frameOverflow}px`);
        assert.ok(metrics.pageWidth > 0, `${width}px settings page remains visible`);
    }
});

test('074 chat to settings round-trip preserves ChatView identity, scroll, DOM budget, and hidden resource counts while guard cancel/proceed both work', { timeout: 300_000 }, async t => {
    const browser = await launch(t);
    if (!browser) return;
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    contexts.push(context);
    const page = await preparePage(context, await startVite());
    const pageErrors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    page.on('pageerror', error => pageErrors.push(error.message));
    await installSettingsRoutes(page);
    await page.route('**/api/dashboard/instances', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ instances: [{ port: 3506, label: 'Settings fixture', workingDir: '/tmp/settings-fixture' }] }),
    }));
    await page.route('**/i/3506/api/messages?**', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
            ok: true,
            data: largeMessages,
            pageInfo: { oldestCursor: 1, newestCursor: largeMessages.length, hasMoreBefore: false, limit: 10_000 },
            snapshotEventSeq: 0,
        }),
    }));

    await page.evaluate(async () => {
        class NoopEventSource {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: (() => void) | null = null;
            close(): void { /* noop */ }
        }
        Object.defineProperty(window, 'EventSource', { configurable: true, value: NoopEventSource });
        const module = await import('/dist/dashboard2/src/dev/settings-harness.tsx');
        module.mountSettingsWorkbenchHarness(document.querySelector<HTMLElement>('#dashboard2-root')!);
    });
    const chat = page.getByTestId('chat-view');
    try {
        await chat.waitFor({ timeout: 10_000 });
    } catch {
        throw new Error(`ChatView failed to mount: ${pageErrors.join(' | ')} :: ${await page.locator('#dashboard2-root').innerText()}`);
    }
    const scroller = page.getByTestId('turn-stream-viewport');
    try {
        await page.locator('.d2-turn-slot').first().waitFor({ timeout: 10_000 });
    } catch {
        throw new Error(`Large chat fixture failed to render: ${pageErrors.join(' | ')} :: ${await page.locator('#dashboard2-root').innerText()}`);
    }
    await page.locator('[data-workspace-surface="settings"] .d2-settings-page h1').waitFor({ state: 'attached' });
    await scroller.evaluate(node => { node.scrollTop = Math.max(1, node.scrollHeight / 2); });

    const before = await page.evaluate(() => {
        const chatNode = document.querySelector('[data-testid="chat-view"]')!;
        const scroll = document.querySelector<HTMLElement>('[data-testid="turn-stream-viewport"]')!;
        (window as typeof window & { __settingsChatNode?: Element }).__settingsChatNode = chatNode;
        return {
            scrollTop: scroll.scrollTop,
            resources: (window as typeof window & { __settingsResourceProbe: { snapshot(): { listeners: number; timers: number } } }).__settingsResourceProbe.snapshot(),
        };
    });

    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('heading', { name: 'Display' }).waitFor();
    const hidden = await page.evaluate(() => ({
        sameChatNode: (window as typeof window & { __settingsChatNode?: Element }).__settingsChatNode === document.querySelector('[data-testid="chat-view"]'),
        resources: (window as typeof window & { __settingsResourceProbe: { snapshot(): { listeners: number; timers: number } } }).__settingsResourceProbe.snapshot(),
    }));
    assert.equal(hidden.sameChatNode, true, 'ChatView host identity implies its memoized TurnStore identity is preserved');
    assert.deepEqual(hidden.resources, before.resources, 'hiding chat adds/removes no listeners or timers');

    await page.getByRole('combobox', { name: /Theme/ }).selectOption('light');
    await page.getByRole('button', { name: 'Save changes' }).waitFor();
    await page.waitForFunction(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    });
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Back to chat' }).click();
    assert.equal(await page.getByRole('heading', { name: 'Display' }).isVisible(), true, 'cancel blocks the transition');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await chat.waitFor({ state: 'visible' });

    const after = await page.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>('[data-testid="turn-stream-viewport"]')!;
        return {
            sameChatNode: (window as typeof window & { __settingsChatNode?: Element }).__settingsChatNode === document.querySelector('[data-testid="chat-view"]'),
            scrollTop: scroll.scrollTop,
            domCount: document.querySelectorAll('*').length,
        };
    });
    assert.equal(after.sameChatNode, true);
    assert.equal(after.scrollTop, before.scrollTop, 'chat scroll position is preserved across the settings round-trip');
    assert.ok(after.domCount < 2_500, `DOM count ${after.domCount} < 2500`);
});
