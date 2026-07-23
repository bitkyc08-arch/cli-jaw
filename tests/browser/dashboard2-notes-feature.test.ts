import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];
const errorsByPage = new WeakMap<Page, string[]>();
after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

const NOTE_PATH = 'daily/today.md';
const NOTE_CONTENT = '# Today\n\n```ts\nconst answer: number = 42;\n```\n\n```mermaid\nflowchart LR\nA-->B\n```\n\nInline $x^2$.\n\n[x](javascript:alert(1))<img src=x onerror="window.__notesXss=1">';

async function openNotes(t: TestContext): Promise<Page | null> {
    let browser: Browser | null = null;
    for (const launch of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try { browser = await launch(); break; } catch { /* local fallback */ }
    }
    if (!browser) { t.skip('no local Chrome/Chromium'); return null; }
    browsers.push(browser);
    const { createServer } = await import('vite');
    const server = await createServer({
        configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent',
        server: { port: 0, host: '127.0.0.1', hmr: false },
    });
    await server.listen();
    servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('vite bind failed');
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const pageErrors: string[] = [];
    errorsByPage.set(page, pageErrors);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/dashboard/notes/**', route => {
        const url = new URL(route.request().url());
        const path = url.searchParams.get('path') ?? NOTE_PATH;
        const body = url.pathname.endsWith('/info') ? { root: '/Users/jun/notes' }
            : url.pathname.endsWith('/tree') ? [{ path: 'daily', name: 'daily', kind: 'folder', mtimeMs: 1, size: 0, children: [{ path: NOTE_PATH, name: 'today.md', kind: 'file', mtimeMs: 1, size: NOTE_CONTENT.length }] }]
            : url.pathname.endsWith('/index') ? { version: 1, notes: [{ path: NOTE_PATH, title: 'Today', aliases: [], tags: [], mtimeMs: 1, size: NOTE_CONTENT.length, revision: 'r1' }], outgoingLinks: {}, backlinks: {}, unresolvedLinks: [] }
            : url.pathname.endsWith('/version') ? { version: 1 }
            : url.pathname.endsWith('/file') ? { path, name: path.split('/').pop(), content: NOTE_CONTENT, revision: 'r1', mtimeMs: 1, size: NOTE_CONTENT.length }
            : {};
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const scopeSource = await (await fetch('/dist/dashboard2/src/state/scope.tsx')).text();
        const harnessSource = await (await fetch('/dist/dashboard2/src/dev/settings-harness.tsx')).text();
        const reactUrl = scopeSource.match(/from "([^"]*\/react\.js\?v=[^"]+)"/)?.[1];
        const reactDomUrl = harnessSource.match(/from "([^"]*\/react-dom_client\.js\?v=[^"]+)"/)?.[1];
        if (!reactUrl || !reactDomUrl) throw new Error('Vite React runtime URLs unavailable');
        const React = (await import(reactUrl)).default;
        const { createRoot } = (await import(reactDomUrl)).default;
        const { AppScopeProvider, useAppScope } = await import('/dist/dashboard2/src/state/scope.tsx');
        const { ManagerApiProvider } = await import('/dist/dashboard2/src/providers/api-provider.tsx');
        const { DesktopBridgeProvider } = await import('/dist/dashboard2/src/providers/desktop-bridge-provider.tsx');
        const { SidePane } = await import('/dist/dashboard2/src/shell/SidePane.tsx');
        const { FilePathLinkLayer } = await import('/dist/dashboard2/src/turn-stream/render/links/FilePathLinkLayer.tsx');
        function App() {
            const [mounted, setMounted] = React.useState(false);
            const scope = useAppScope();
            const [linkHost, setLinkHost] = React.useState<HTMLDivElement | null>(null);
            window.__notesFeature = { scope, mount: () => setMounted(true) };
            return React.createElement('div', { style: { width: '700px', height: '520px' } },
                React.createElement('div', { ref: setLinkHost }, '/Users/jun/notes/daily/today.md /tmp/nope.md /Users/jun/notes/daily/nope.txt'),
                React.createElement(FilePathLinkLayer, { host: linkHost, revision: 'notes-feature' }),
                mounted ? React.createElement('div', { className: 'd2-side-pane-tab-slot', style: { width: '700px', height: '470px' } },
                    React.createElement(SidePane, { open: true, onClose: () => scope.guardedCloseSidePane() })) : null,
            );
        }
        createRoot(document.querySelector('#dashboard2-root')!).render(React.createElement(
            ManagerApiProvider,
            null,
            React.createElement(AppScopeProvider, null, React.createElement(DesktopBridgeProvider, null, React.createElement(App))),
        ));
    });
    try {
        await page.waitForFunction(() => Boolean(window.__notesFeature), null, { timeout: 5_000 });
    } catch {
        throw new Error(`notes harness failed: ${pageErrors.join(' | ') || 'no pageerror captured'}`);
    }
    await page.evaluate(() => window.__notesFeature!.scope.guardedSelectSession(3457, 'notes-feature'));
    await page.waitForFunction(() => window.__notesFeature!.scope.selected?.sessionId === 'notes-feature');
    return page;
}

async function waitForNotes(page: Page, predicate: () => boolean, label: string): Promise<void> {
    try {
        await page.waitForFunction(predicate, null, { timeout: 5_000 });
    } catch {
        const state = await page.evaluate(() => ({
            html: document.querySelector('#dashboard2-root')?.innerHTML.slice(0, 2_000),
            activePanelId: window.__notesFeature?.scope.activePanelId,
            pending: window.__notesFeature?.scope.pendingNotesIntent,
            fileLinks: document.querySelectorAll('[data-file-link]').length,
            noteActions: document.querySelectorAll('[data-notes-open-path]').length,
        }));
        throw new Error(`${label}: ${JSON.stringify(state)} errors=${errorsByPage.get(page)?.join(' | ') || 'none'}`);
    }
}

test('071 preview-open action is notes-root markdown only and lazy intent selects, expands, and flashes', { timeout: 240_000 }, async t => {
    const page = await openNotes(t); if (!page) return;
    await waitForNotes(page, () => document.querySelectorAll('[data-notes-open-path]').length === 1, 'notes action missing');
    assert.equal(await page.locator('[data-notes-open-path]').count(), 1);
    assert.equal(await page.locator('[data-notes-open-path]').getAttribute('data-notes-open-path'), '/Users/jun/notes/daily/today.md');
    await page.locator('[data-notes-open-path]').click();
    await page.waitForFunction(() => window.__notesFeature!.scope.pendingNotesIntent?.path === 'daily/today.md');
    assert.deepEqual(await page.evaluate(() => window.__notesFeature!.scope.pendingNotesIntent), { path: NOTE_PATH, seq: 1 });
    await page.waitForFunction(() => Boolean(window.__notesFeature!.scope.activePanelId));
    await page.evaluate(() => window.__notesFeature!.mount());
    const selected = page.locator(`[data-notes-path="${NOTE_PATH}"]`);
    await waitForNotes(page, () => Boolean(document.querySelector('[data-notes-path="daily/today.md"]')), 'selected note missing');
    assert.equal(await selected.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[data-notes-path="daily"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await selected.locator('xpath=..').evaluate(node => node.classList.contains('is-flashing')), true);
    await page.waitForFunction(() => window.__notesFeature!.scope.pendingNotesIntent === null);
});

test('071 shared sanitizer, Mermaid owner, highlight service, and KaTeX snapshot render safely', { timeout: 240_000 }, async t => {
    const page = await openNotes(t); if (!page) return;
    await page.evaluate(() => window.__notesFeature!.scope.openNotesAt('/Users/jun/notes/daily/today.md'));
    await page.waitForFunction(() => Boolean(window.__notesFeature!.scope.activePanelId));
    await page.evaluate(() => window.__notesFeature!.mount());
    await waitForNotes(page, () => Boolean(document.querySelector('.d2-notes-toolbar')), 'notes toolbar missing');
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.waitForFunction(() => document.querySelector('.notes-code-block code')?.getAttribute('data-highlighted') === 'yes');
    await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('.d2-mermaid')?.getAttribute('data-state') ?? ''));
    assert.equal(await page.evaluate(() => window.__notesXss), undefined);
    assert.equal(await page.locator('.d2-notes-preview script, .d2-notes-preview img[src="x"]').count(), 0);
    assert.equal(await page.locator('.d2-notes-preview a').getAttribute('href'), null);
    assert.ok(await page.evaluate(async () => (await import('/dist/dashboard2/src/turn-stream/render/highlight-service.ts')).getHighlightService().metrics.requests) >= 1);
    assert.match(await page.locator('.d2-mermaid').getAttribute('data-state') ?? '', /ready|error/);
    const katexSnapshot = await page.locator('.katex').evaluate(node => ({
        text: node.textContent,
        className: node.className,
        ariaHidden: node.querySelectorAll('[aria-hidden="true"]').length,
    }));
    assert.deepEqual(katexSnapshot, { text: 'x2x^2x2', className: 'katex', ariaHidden: 1 });
    const codeSource = readFileSync(join(ROOT, 'public/dashboard2/src/features/notes/rendering/CodeBlock.tsx'), 'utf8');
    assert.match(codeSource, /getHighlightService/);
    assert.doesNotMatch(codeSource, /highlight\.js|highlight-languages/);
});

test('071 dirty guard covers select-session, close-panel, Cmd+W, and 280/500/700 layout branches', { timeout: 240_000 }, async t => {
    const page = await openNotes(t); if (!page) return;
    await page.evaluate(() => window.__notesFeature!.scope.openNotesAt('/Users/jun/notes/daily/today.md'));
    await page.waitForFunction(() => Boolean(window.__notesFeature!.scope.activePanelId));
    await page.evaluate(() => window.__notesFeature!.mount());
    const editor = page.getByRole('textbox', { name: `Edit ${NOTE_PATH}` });
    await waitForNotes(page, () => Boolean(document.querySelector('[aria-label="Edit daily/today.md"]')), 'notes editor missing');
    await editor.fill(`${NOTE_CONTENT}\ndirty`);
    await page.evaluate(() => { window.confirm = () => false; });
    assert.equal(await page.evaluate(() => window.__notesFeature!.scope.guardedSelectSession(3457, 'blocked')), false);
    assert.deepEqual(await page.evaluate(() => window.__notesFeature!.scope.selected), { port: 3457, sessionId: 'notes-feature' });
    const panelId = await page.evaluate(() => window.__notesFeature!.scope.activePanelId!);
    assert.equal(await page.evaluate(id => window.__notesFeature!.scope.guardedClosePanel(id), panelId), false);
    await editor.focus();
    await page.keyboard.press('Meta+w');
    assert.equal(await page.evaluate(() => window.__notesFeature!.scope.activePanelId), panelId);

    await page.evaluate(() => { window.confirm = () => true; });
    assert.equal(await page.evaluate(() => window.__notesFeature!.scope.guardedSelectSession(3457, 'approved')), true);
    await page.waitForFunction(() => window.__notesFeature!.scope.selected?.sessionId === 'approved');
    assert.deepEqual(await page.evaluate(() => window.__notesFeature!.scope.selected), { port: 3457, sessionId: 'approved' });

    for (const [width, tier] of [[280, 'narrow'], [500, 'medium'], [700, 'wide']] as const) {
        const actual = await page.getByRole('tabpanel', { name: 'Notes' }).evaluate((node, nextWidth) => {
            (node as HTMLElement).style.width = `${nextWidth}px`;
            return new Promise<string>(resolve => requestAnimationFrame(() => resolve(getComputedStyle(node.querySelector('.d2-notes-panel')!).getPropertyValue('--notes-layout-tier').trim())));
        }, width);
        assert.equal(actual, tier, `${width}px layout tier`);
    }
});

declare global {
    interface Window {
        __notesFeature?: {
            scope: import('../../public/dashboard2/src/state/scope.tsx').AppScopeValue;
            mount(): void;
        };
        __notesXss?: number;
    }
}
