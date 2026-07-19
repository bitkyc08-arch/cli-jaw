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

type RouteMode = 'default' | 'html-tree' | 'race' | 'slow-search';
let routeMode: RouteMode = 'default';

const NOTE_A = { path: 'a.md', content: 'AAA-content', baseRevision: '1' };
const NOTE_B = { path: 'b.md', content: 'BBB-content', baseRevision: '1' };

async function fulfill(route: Parameters<Parameters<Page['route']>[1]>[0], body: unknown, status = 200, contentType = 'application/json', delayMs = 0): Promise<void> {
    if (delayMs > 0) await new Promise(resolveWait => setTimeout(resolveWait, delayMs));
    await route.fulfill({ status, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function openHarness(t: TestContext): Promise<Page | null> {
    let browser: Browser | null = null;
    for (const launch of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try { browser = await launch(); break; } catch { /* local fallback */ }
    }
    // 070 P5: a skipped run can never ground a NOOP verdict.
    if (!browser) { t.skip('no local Chrome/Chromium — NOOP verdict requires executed captures'); return null; }
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
    const context = await browser.newContext({ viewport: { width: 760, height: 420 } });
    contexts.push(context);
    const page = await context.newPage();

    await page.route('**/api/dashboard/notes/**', async route => {
        const url = route.request().url();
        if (routeMode === 'html-tree' && url.includes('/tree')) {
            return fulfill(route, '<html><body>manager fallback</body></html>', 200, 'text/html');
        }
        if (routeMode === 'race') {
            if (url.includes('path=a.md')) return fulfill(route, NOTE_A, 200, 'application/json', 700);
            if (url.includes('path=b.md')) return fulfill(route, NOTE_B);
        }
        if (routeMode === 'slow-search' && url.includes('/search')) {
            return fulfill(route, [], 200, 'application/json', 2500);
        }
        if (url.includes('/info')) return fulfill(route, { root: '/vault' });
        if (url.includes('/version')) return fulfill(route, { version: 1 });
        if (url.includes('/tree')) return fulfill(route, []);
        if (url.includes('/index')) return fulfill(route, { notes: [], generatedAt: 0 });
        if (url.includes('/file')) return fulfill(route, NOTE_B);
        if (url.includes('/search')) return fulfill(route, []);
        return fulfill(route, {});
    });
    await page.route('**/i/3506/api/code/sessions**', route => fulfill(route, { ok: true, sessions: [] }));

    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        document.documentElement.dataset.cliJawDesktop = 'true';
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/dev/runtime-api-wire-harness.tsx');
        module.mountRuntimeApiWireHarness(target);
    });
    await page.getByTestId('runtime-api-wire-harness').waitFor();
    return page;
}

interface WireCaptureEntry {
    url: string;
    method: string;
    body: string | null;
    headers: Record<string, string>;
    stack: string;
}

async function captures(page: Page): Promise<WireCaptureEntry[]> {
    return await page.evaluate(() => window.__wireCapture ?? []) as WireCaptureEntry[];
}

test('notes/info wire capture proves a bodiless GET with headers and callsite stack', async t => {
    const page = await openHarness(t);
    if (!page) return;
    await page.waitForFunction(() => (window.__wireCapture ?? []).some(entry => entry.url.includes('/api/dashboard/notes/info')));
    const entries = await captures(page);
    assert.ok(entries.length >= 1, 'NOOP decision requires at least one captured request');

    const info = entries.filter(entry => entry.url.includes('/api/dashboard/notes/info'));
    assert.ok(info.length >= 1);
    for (const entry of info) {
        assert.equal(entry.method, 'GET', 'notes/info must be a GET');
        assert.equal(entry.body, null, 'notes/info must not carry a body (H11 GET-body hypothesis)');
        assert.equal(entry.url.includes('/i/'), false, 'manager-owned route must not use the worker prefix');
        assert.ok(entry.stack.includes('notes-api'), `stack should contain the callsite: ${entry.stack}`);
    }
    // Header capture reflects init.headers only (browser defaults are applied
    // below this seam): GET sends none, POST sends content-type json.
    assert.ok(info[0] && typeof info[0].headers === 'object');
    assert.equal(info[0].headers['content-type'], undefined);
    await page.evaluate(async () => {
        const module = await import('/dist/dashboard2/src/features/notes/notes-api.ts');
        await module.createNoteFile('header-check.md', 'x').catch(() => null);
    });
    const posts = (await captures(page)).filter(entry => entry.url.includes('/api/dashboard/notes/file') && entry.method === 'POST');
    assert.ok(posts.length >= 1, 'POST capture exists');
    assert.equal(posts[0]?.headers['content-type'], 'application/json');
});

test('route ownership: worker-scoped clients carry the /i/:port prefix', async t => {
    const page = await openHarness(t);
    if (!page) return;
    await page.evaluate(async () => {
        const module = await import('/dist/dashboard2/src/code/code-api-client.ts');
        const client = module.createCodeApiClient(3506);
        await client.listSessions();
    });
    const entries = await captures(page);
    const worker = entries.filter(entry => entry.url.includes('/api/code/sessions'));
    assert.ok(worker.length >= 1, 'code client request captured');
    for (const entry of worker) {
        assert.ok(entry.url.includes('/i/3506/'), `worker-owned route must use the instance prefix: ${entry.url}`);
    }
    const notes = entries.filter(entry => entry.url.includes('/api/dashboard/notes/'));
    for (const entry of notes) {
        assert.equal(entry.url.includes('/i/'), false, `manager-owned route leaked the worker prefix: ${entry.url}`);
    }
});

test('intentional HTML 200 surfaces a typed error at the model UI level', async t => {
    const page = await openHarness(t);
    if (!page) return;
    routeMode = 'html-tree';
    try {
        await page.evaluate(() => window.__wireModel!.refresh());
        await page.waitForFunction(
            () => document.querySelector('[data-testid="notes-error"]')?.textContent?.includes('not JSON'),
            null,
            { timeout: 15_000 },
        );
    } finally {
        routeMode = 'default';
    }
});

test('404/401/500 responses raise typed NotesApiError with status', async t => {
    const page = await openHarness(t);
    if (!page) return;
    for (const status of [404, 401, 500]) {
        await page.route(`**/api/dashboard/notes/file*status-${status}*`, route => (
            route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: `boom-${status}` }) })
        ));
        const result = await page.evaluate(async path => {
            const module = await import('/dist/dashboard2/src/features/notes/notes-api.ts');
            try {
                await module.fetchNoteFile(path);
                return { threw: false } as const;
            } catch (error) {
                const typed = error as { name?: string; status?: number; message?: string };
                return { threw: true, name: typed.name, status: typed.status, message: typed.message } as const;
            }
        }, `status-${status}.md`);
        assert.equal(result.threw, true);
        if (result.threw) {
            assert.equal(result.name, 'NotesApiError');
            assert.equal(result.status, status);
            assert.ok(result.message?.includes(`boom-${status}`), `body.error should win: ${result.message}`);
        }
    }
});

test('useNoteDocument stale-load race: an older response must not clobber a newer note', async t => {
    const page = await openHarness(t);
    if (!page) return;
    routeMode = 'race';
    try {
        await page.evaluate(() => window.__wireProbe!.loadBoth('a.md', 'b.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.waitForFunction(
            () => ['AAA-content', 'BBB-content'].includes(document.querySelector('[data-testid="doc-content"]')?.textContent ?? ''),
            null,
            { timeout: 15_000 },
        );
        const finalContent = await page.getByTestId('doc-content').textContent();
        const finalPath = await page.getByTestId('doc-path').textContent();
        // 071 defect reproduction record: the unguarded race currently lets the
        // older response clobber the newer note. The 071 work-phase adds the
        // generation guard and flips this assertion to BBB-content.
        console.log(JSON.stringify({
            probe: 'useNoteDocument-race', finalContent, finalPath,
            raceReproduced: finalContent === 'AAA-content',
        }));
        assert.equal(finalContent, 'AAA-content', 'defect reproduced on 2026-07-19; 071 generation-guard must flip this to BBB-content');
    } finally {
        routeMode = 'default';
    }
});

test('aborting an in-flight notes search rejects and never resolves late', async t => {
    const page = await openHarness(t);
    if (!page) return;
    routeMode = 'slow-search';
    try {
        const result = await page.evaluate(async () => {
            const module = await import('/dist/dashboard2/src/features/notes/notes-api.ts');
            const controller = new AbortController();
            const pending = module.searchNotes('vault', { signal: controller.signal });
            let settled = false;
            const tracker = pending.then(
                () => { settled = true; return 'resolved' as const; },
                (error: unknown) => { settled = true; return `rejected:${(error as Error).name}` as const; },
            );
            controller.abort();
            const outcome = await tracker;
            await new Promise(resolveWait => setTimeout(resolveWait, 3000));
            return { outcome, settledAfterAbort: settled };
        });
        assert.match(result.outcome, /^rejected:/, 'aborted search must reject');
        assert.equal(result.settledAfterAbort, true);
        assert.notEqual(result.outcome, 'resolved', 'aborted request must never resolve late');
    } finally {
        routeMode = 'default';
    }
});
