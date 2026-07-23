import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [], contexts: BrowserContext[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
after(async () => {
    await Promise.allSettled(contexts.map(value => value.close()));
    await Promise.allSettled(browsers.map(value => value.close()));
    await Promise.allSettled(servers.map(value => value.close()));
});

async function browserOrFail(): Promise<Browser> {
    for (const launch of [() => chromium.launch({ headless: true, channel: 'chrome' as const }), () => chromium.launch({ headless: true })]) {
        try { const browser = await launch(); browsers.push(browser); return browser; } catch { /* try next local binary */ }
    }
    throw new Error('dashboard2 Electron rendered e2e requires local Chrome/Chromium');
}

test('fake preload is installed before provider creation and executes Terminal, Files, Browser, and shortcut lifecycle cleanup', { timeout: 240_000 }, async () => {
    const browser = await browserOrFail();
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen(); servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('Vite failed to bind');
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } }); contexts.push(context);
    const page = await context.newPage();

    await page.addInitScript({ content: 'window.__name = window.__name || ((fn) => fn);' });
    await page.addInitScript(() => {
        const state = {
            calls: [] as string[], terminalData: [] as Array<(id: string, data: string, seq?: number) => void>, terminalExit: [] as Array<(id: string, code: number | null) => void>,
            shortcuts: [] as Array<(action: string) => void>, dir: [] as Array<(path: string) => void>, browserState: [] as Array<(value: Record<string, unknown>) => void>, browserOpen: [] as Array<(value: Record<string, unknown>) => void>,
        };
        (window as typeof window & { __electronE2E: typeof state }).__electronE2E = state;
        (window as typeof window & { __electronStage?: number }).__electronStage = 1;
        function remove(items: unknown[], value: unknown): () => void {
            return () => { const index = items.indexOf(value); if (index >= 0) items.splice(index, 1); };
        }
        (window as typeof window & { __electronStage?: number }).__electronStage = 2;
        const browserSnapshot = (url = 'https://example.test/') => ({ tabId: 'browser:side-panel-3:1', webContentsId: 77, url, title: 'WP4 Browser', loading: false, canGoBack: false, canGoForward: false });
        (window as typeof window & { __electronStage?: number }).__electronStage = 3;
        (window as typeof window & { cliJawDesktop?: unknown }).cliJawDesktop = {
            identify: () => ({ name: 'cli-jaw-desktop', electron: true }), getHomePath: () => '/tmp/wp4-e2e', reloadWindow: async () => {}, hardReloadWindow: async () => {},
            terminal: {
                list: async () => ({ ok: true, sessions: [] }),
                create: async () => { state.calls.push('terminal:create'); return { ok: true, id: 'pty-1', shell: '/bin/zsh', cwd: '/tmp/wp4-e2e' }; },
                write: async (_id: string, data: string) => { state.calls.push(`terminal:write:${data}`); }, resize: async () => { state.calls.push('terminal:resize'); }, kill: async () => { state.calls.push('terminal:kill'); },
                onData: (callback: (id: string, data: string, seq?: number) => void) => { state.terminalData.push(callback); return remove(state.terminalData, callback); },
                onExit: (callback: (id: string, code: number | null) => void) => { state.terminalExit.push(callback); return remove(state.terminalExit, callback); },
            },
            folder: {
                getDefaultRoot: async () => ({ ok: true, path: '/tmp/wp4-e2e' }), pickFolder: async () => ({ ok: true, path: '/tmp/wp4-e2e' }), pickFile: async () => ({ ok: true, path: '/tmp/wp4-e2e/fixture.txt' }), authorizeRoot: async (path: string) => ({ ok: true, path }), registerGitWorktreeRoot: async () => ({ ok: true, path: '/tmp/wp4-e2e' }),
                listDir: async () => ({ ok: true, entries: [{ name: 'fixture.txt', path: '/tmp/wp4-e2e/fixture.txt', kind: 'file', size: 18 }] }),
                readFile: async () => { state.calls.push('files:read'); return { ok: true, content: 'electron temp receipt', truncated: false, binary: false }; },
                movePath: async () => ({ ok: true }), createFile: async () => ({ ok: true }), createFolder: async () => ({ ok: true }), renamePath: async () => ({ ok: true }), revealPath: async () => ({ ok: true }), watchDir: async () => ({ ok: true }), unwatchDir: async () => ({ ok: true }),
                onDirChange: (callback: (path: string) => void) => { state.dir.push(callback); return remove(state.dir, callback); },
            },
            shortcuts: { onAction: (callback: (action: string) => void) => { state.shortcuts.push(callback); return remove(state.shortcuts, callback); } },
            clipboard: { writeText: async () => ({ ok: true }) },
            browser: {
                onOpenUrl: (callback: (value: Record<string, unknown>) => void) => { state.browserOpen.push(callback); return remove(state.browserOpen, callback); },
                registerWebview: async ({ tabId }: { tabId: string }) => { state.calls.push('browser:register'); return { ok: true, state: { ...browserSnapshot(), tabId } }; },
                unregisterWebview: async () => { state.calls.push('browser:unregister'); return { ok: true }; },
                controlWebview: async (command: { kind: string; tabId: string; url?: string }) => { state.calls.push(`browser:${command.kind}`); return { ok: true, state: { ...browserSnapshot(command.url), tabId: command.tabId } }; },
                performWebviewAction: async () => ({ ok: true, state: browserSnapshot() }), getWebviewTabs: async () => ({ ok: true, tabs: [browserSnapshot()] }),
                onWebviewState: (callback: (value: Record<string, unknown>) => void) => { state.browserState.push(callback); return remove(state.browserState, callback); }, onElementPicked: () => () => {},
            },
        };
        (window as typeof window & { __electronStage?: number }).__electronStage = 4;
    });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: 'import { mountE2EAppHarness } from "/dist/dashboard2/src/dev/e2e-app-harness.tsx"; mountE2EAppHarness(document.querySelector("#dashboard2-root"), { historyCount: 20 });' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('chat-view').waitFor();
    assert.deepEqual(await page.evaluate(() => ({ fixture: Boolean((window as typeof window & { __electronE2E?: unknown }).__electronE2E), preload: Boolean((window as typeof window & { cliJawDesktop?: unknown }).cliJawDesktop), stage: (window as typeof window & { __electronStage?: number }).__electronStage })), { fixture: true, preload: true, stage: 4 }, 'preload fixture installs before the provider tree');
    await page.evaluate(() => { (HTMLElement.prototype as HTMLElement & { getWebContentsId?: () => number }).getWebContentsId = () => 77; });
    assert.equal(await page.evaluate(() => window.__jawE2E.diagnostics().selected), '3506/wp4-e2e-session');

    await page.evaluate(() => window.__jawE2E.openPanel('terminal'));
    try {
        await page.getByRole('tab', { name: /zsh 1|Terminal 1/ }).waitFor({ timeout: 8_000 });
    } catch (error) {
        const diagnostic = await page.evaluate(() => ({
            pane: document.querySelector('.d2-side-pane')?.textContent,
            calls: (window as typeof window & { __electronE2E?: { calls: string[] } }).__electronE2E?.calls,
            bridge: Boolean((window as typeof window & { cliJawDesktop?: unknown }).cliJawDesktop),
        }));
        throw new Error(`Terminal did not hydrate: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const terminalBaseline = await page.evaluate(() => (window as typeof window & { __electronE2E: { shortcuts: unknown[] } }).__electronE2E.shortcuts.length);
    await page.evaluate(() => {
        const state = (window as typeof window & { __electronE2E: { terminalData: Array<(id: string, data: string, seq?: number) => void>; terminalExit: Array<(id: string, code: number | null) => void> } }).__electronE2E;
        state.terminalData.forEach(callback => callback('pty-1', 'terminal output\n', 1));
        state.terminalExit.forEach(callback => callback('pty-1', 0));
    });
    await page.getByRole('status').filter({ hasText: /exited.*0/i }).waitFor();
    assert.ok((await page.evaluate(() => (window as typeof window & { __electronE2E: { calls: string[] } }).__electronE2E.calls)).includes('terminal:create'));
    await page.getByRole('button', { name: 'Close Terminal', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => !(window as typeof window & { __electronE2E: { terminalData: unknown[]; terminalExit: unknown[] } }).__electronE2E.terminalData.length && !(window as typeof window & { __electronE2E: { terminalData: unknown[]; terminalExit: unknown[] } }).__electronE2E.terminalExit.length);
    assert.equal(await page.evaluate(() => (window as typeof window & { __electronE2E: { shortcuts: unknown[] } }).__electronE2E.shortcuts.length), terminalBaseline - 1, 'terminal shortcut subscription cleans up');

    await page.evaluate(() => window.__jawE2E.openPanel('files'));
    await page.getByRole('treeitem', { name: /fixture\.txt/ }).click();
    await page.getByText('electron temp receipt').waitFor();
    assert.ok((await page.evaluate(() => (window as typeof window & { __electronE2E: { calls: string[] } }).__electronE2E.calls)).includes('files:read'));
    await page.getByRole('button', { name: 'Close Files', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => !(window as typeof window & { __electronE2E: { dir: unknown[] } }).__electronE2E.dir.length);

    await page.evaluate(() => window.__jawE2E.openPanel('browser'));
    await page.getByRole('textbox', { name: 'URL' }).fill('example.test');
    await page.getByRole('button', { name: 'Go' }).click();
    const webview = page.locator('webview'); await webview.waitFor();
    await webview.dispatchEvent('dom-ready');
    await page.waitForFunction(() => (window as typeof window & { __electronE2E: { calls: string[] } }).__electronE2E.calls.includes('browser:register'));
    await page.getByRole('region', { name: 'WP4 Browser' }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'WP4 Browser' }).count(), 1, 'bridge state reaches the rendered Browser panel');
    await page.getByRole('button', { name: 'Close Browser', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => {
        const state = (window as typeof window & { __electronE2E: { browserState: unknown[]; browserOpen: unknown[] } }).__electronE2E;
        return state.browserState.length === 0 && state.browserOpen.length === 0;
    });
    assert.ok((await page.evaluate(() => (window as typeof window & { __electronE2E: { calls: string[] } }).__electronE2E.calls)).includes('browser:unregister'));
});
