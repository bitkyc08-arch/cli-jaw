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

function noteFile(path: string, content: string, revision = 'r1') {
    return { path, name: path.split('/').pop(), content, revision, mtimeMs: 1_700_000_000_000, size: content.length };
}
const NOTE_A = noteFile('a.md', 'AAA-content');
const NOTE_B = noteFile('b.md', 'BBB-content');

// Programmable per-test behaviors for GET /file?path=<key> and PUT /file.
interface FileBehavior { delayMs?: number; status?: number; body?: unknown }
let getBehaviors: Record<string, FileBehavior> = {};
let putBehavior: (FileBehavior & { conflict?: boolean }) | null = null;

function resetBehaviors(): void {
    getBehaviors = {};
    putBehavior = null;
    routeMode = 'default';
}

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
        const method = route.request().method();
        if (routeMode === 'html-tree' && url.includes('/tree')) {
            return fulfill(route, '<html><body>manager fallback</body></html>', 200, 'text/html');
        }
        if (routeMode === 'slow-search' && url.includes('/search')) {
            return fulfill(route, [], 200, 'application/json', 2500);
        }
        if (url.includes('/file') && method === 'PUT') {
            const body = route.request().postDataJSON() as { path?: string; content?: string } | null;
            const behavior = putBehavior ?? {};
            if (behavior.status && behavior.status !== 200) {
                return fulfill(route, behavior.body ?? { ok: false, error: 'boom' }, behavior.status, 'application/json', behavior.delayMs ?? 0);
            }
            return fulfill(route, noteFile(body?.path ?? 'x.md', body?.content ?? '', 'r2'), 200, 'application/json', behavior.delayMs ?? 0);
        }
        if (url.includes('/file') && method === 'GET') {
            const path = new URL(url).searchParams.get('path') ?? '';
            const behavior = getBehaviors[path];
            if (behavior) {
                if (behavior.status && behavior.status !== 200) {
                    return fulfill(route, behavior.body ?? { ok: false, error: 'boom' }, behavior.status, 'application/json', behavior.delayMs ?? 0);
                }
                return fulfill(route, behavior.body ?? noteFile(path, `${path}-content`), 200, 'application/json', behavior.delayMs ?? 0);
            }
            if (path === 'a.md') return fulfill(route, NOTE_A);
            return fulfill(route, NOTE_B);
        }
        if (url.includes('/info')) return fulfill(route, { root: '/vault' });
        if (url.includes('/version')) return fulfill(route, { version: 1 });
        if (url.includes('/tree')) return fulfill(route, []);
        if (url.includes('/index')) return fulfill(route, { notes: [], generatedAt: 0 });
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
    getBehaviors['a.md'] = { body: NOTE_A, delayMs: 700 };
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
        // 071 fixed: the generation guard discards the stale A completion.
        // (Defect reproduction record 2026-07-19: AAA-content/raceReproduced.)
        console.log(JSON.stringify({
            probe: 'useNoteDocument-race', finalContent, finalPath,
            raceReproduced: finalContent === 'AAA-content',
        }));
        assert.equal(finalContent, 'BBB-content');
        assert.equal(finalPath, 'b.md');
    } finally {
        resetBehaviors();
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

// ---- 071 race matrix: shared doc-op generation guard activation evidence ----

async function probeState(page: Page): Promise<Record<string, string>> {
    const read = async (id: string) => (await page.getByTestId(id).textContent()) ?? '';
    return {
        path: await read('doc-path'),
        content: await read('doc-content'),
        error: await read('doc-error'),
        loading: await read('doc-loading'),
        dirty: await read('doc-dirty'),
        revision: await read('doc-revision'),
        conflict: await read('doc-conflict'),
    };
}

async function putCaptures(page: Page): Promise<WireCaptureEntry[]> {
    return (await captures(page)).filter(entry => entry.method === 'PUT' && entry.url.includes('/api/dashboard/notes/file'));
}

async function getCapturesFor(page: Page, fragment: string): Promise<WireCaptureEntry[]> {
    return (await captures(page)).filter(entry => entry.method === 'GET' && entry.url.includes(fragment));
}

test('071: save from residual A state is refused while B load is pending', async t => {
    const page = await openHarness(t);
    if (!page) return;
    getBehaviors['b.md'] = { body: NOTE_B, delayMs: 800 };
    try {
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('edited-A'));
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.evaluate(() => { void window.__wireProbe!.save(); });
        await page.evaluate(() => window.__wireProbe!.settled());
        assert.equal((await putCaptures(page)).length, 0, 'no A write may dispatch while B is pending');
        const state = await probeState(page);
        assert.equal(state.content, 'BBB-content');
        assert.equal(state.path, 'b.md');
    } finally {
        resetBehaviors();
    }
});

test('071: save invoked before a pre-settle navigation dispatches nothing', async t => {
    const page = await openHarness(t);
    if (!page) return;
    try {
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('edited-A'));
        // save() settles pending editor changes first; load(B) must land inside
        // that window — issue both in one task so the interleave is deterministic.
        await page.evaluate(() => {
            const savePromise = window.__wireProbe!.save();
            void window.__wireProbe!.load('b.md');
            return savePromise;
        });
        await page.evaluate(() => window.__wireProbe!.settled());
        assert.equal((await putCaptures(page)).length, 0, 'stale save must return before dispatching');
        const state = await probeState(page);
        assert.equal(state.content, 'BBB-content');
    } finally {
        resetBehaviors();
    }
});

test('071: 409 recovery bails at branch entry after navigation (zero recovery GETs)', async t => {
    const page = await openHarness(t);
    if (!page) return;
    putBehavior = { status: 409, body: { ok: false, error: 'conflict', code: 'note_revision_conflict' }, delayMs: 700 };
    try {
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('edited-A'));
        await page.evaluate(() => { void window.__wireProbe!.save(); });
        await page.waitForTimeout(150); // settle passed, PUT in flight
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.evaluate(() => window.__wireProbe!.settled());
        assert.equal((await putCaptures(page)).length, 1, 'the save PUT did dispatch before navigation');
        assert.equal((await getCapturesFor(page, 'path=a.md')).length, 1, 'recovery must not fetch A after navigation');
        const state = await probeState(page);
        assert.equal(state.content, 'BBB-content');
        assert.equal(state.conflict, '', 'no conflict state may leak into B');
    } finally {
        resetBehaviors();
    }
});

test('071: overwrite after a real conflict does not pollute a later navigation', async t => {
    const page = await openHarness(t);
    if (!page) return;
    try {
        // Produce a genuine conflict first so overwrite() is meaningful.
        putBehavior = { status: 409, body: { ok: false, error: 'conflict', code: 'note_revision_conflict' } };
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('edited-A'));
        await page.evaluate(() => { void window.__wireProbe!.save(); });
        await page.evaluate(() => window.__wireProbe!.settled());
        assert.equal((await probeState(page)).conflict, 'conflict');

        putBehavior = { status: 200, delayMs: 700 };
        await page.evaluate(() => window.__wireProbe!.edit('overwrite-A'));
        await page.evaluate(() => { void window.__wireProbe!.overwrite(); });
        await page.waitForTimeout(150);
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.evaluate(() => window.__wireProbe!.settled());
        const state = await probeState(page);
        assert.equal(state.content, 'BBB-content');
        assert.equal(state.path, 'b.md');
        assert.equal(state.conflict, '', 'stale overwrite must not clear or set conflict on B');
    } finally {
        resetBehaviors();
    }
});

test('071: a stale failing A creates no error state after B wins', async t => {
    const page = await openHarness(t);
    if (!page) return;
    getBehaviors['a.md'] = { status: 500, body: { ok: false, error: 'boom-A' }, delayMs: 700 };
    try {
        await page.evaluate(() => { void window.__wireProbe!.load('a.md'); });
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.evaluate(() => window.__wireProbe!.settled());
        const state = await probeState(page);
        assert.equal(state.content, 'BBB-content');
        assert.equal(state.error, '', 'stale failure must not surface an error');
    } finally {
        resetBehaviors();
    }
});

test('071: stale A finishing while B is pending never clears B loading', async t => {
    const page = await openHarness(t);
    if (!page) return;
    getBehaviors['a.md'] = { body: NOTE_A, delayMs: 400 };
    getBehaviors['b.md'] = { body: NOTE_B, delayMs: 1200 };
    try {
        await page.evaluate(() => { void window.__wireProbe!.load('a.md'); });
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.waitForTimeout(700); // A resolved stale; B still in flight
        assert.equal((await probeState(page)).loading, 'true', 'B loading must survive the stale A completion');
        await page.evaluate(() => window.__wireProbe!.settled());
        assert.equal((await probeState(page)).content, 'BBB-content');
    } finally {
        resetBehaviors();
    }
});

test('071: save adopts the new revision while a newer edit stays dirty', async t => {
    const page = await openHarness(t);
    if (!page) return;
    putBehavior = { status: 200, delayMs: 600 };
    try {
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('v1'));
        await page.evaluate(() => { void window.__wireProbe!.save(); });
        await page.waitForTimeout(150);
        await page.evaluate(() => window.__wireProbe!.edit('v2'));
        await page.evaluate(() => window.__wireProbe!.settled());
        const state = await probeState(page);
        assert.equal(state.revision, 'r2', 'saved revision adopted for the next baseRevision');
        assert.equal(state.dirty, 'true', 'the newer edit stays dirty');
        assert.equal(state.content, 'v2', 'newer edit content is preserved');
    } finally {
        resetBehaviors();
    }
});

test('071: a stale successful save applies nothing after navigation', async t => {
    const page = await openHarness(t);
    if (!page) return;
    putBehavior = { status: 200, delayMs: 700 };
    try {
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('edited-A'));
        await page.evaluate(() => { void window.__wireProbe!.save(); });
        await page.waitForTimeout(150); // PUT in flight
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.evaluate(() => window.__wireProbe!.settled());
        const state = await probeState(page);
        assert.equal(state.path, 'b.md', 'stale save must not restore A file metadata');
        assert.equal(state.content, 'BBB-content');
        assert.equal(state.revision, 'r1', 'stale save revision must not be adopted');
    } finally {
        resetBehaviors();
    }
});

test('071: navigation during the recovery GET discards the post-fetch application', async t => {
    const page = await openHarness(t);
    if (!page) return;
    putBehavior = { status: 409, body: { ok: false, error: 'conflict', code: 'note_revision_conflict' } };
    getBehaviors['a.md'] = { body: noteFile('a.md', 'remote-A', 'r9'), delayMs: 700 };
    try {
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('edited-A'));
        await page.evaluate(() => { void window.__wireProbe!.save(); });
        // The 409 arrives fast; the recovery GET for A is slow. Navigate mid-fetch.
        await page.waitForFunction(() => (window.__wireCapture ?? []).filter(
            entry => entry.method === 'GET' && entry.url.includes('path=a.md'),
        ).length >= 2);
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.evaluate(() => window.__wireProbe!.settled());
        const state = await probeState(page);
        assert.equal(state.content, 'BBB-content');
        assert.equal(state.path, 'b.md');
        assert.equal(state.conflict, '', 'recovery must not plant A conflict on B');
    } finally {
        resetBehaviors();
    }
});

test('071: overwrite from residual A state is refused while B load is pending', async t => {
    const page = await openHarness(t);
    if (!page) return;
    getBehaviors['b.md'] = { body: NOTE_B, delayMs: 800 };
    try {
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('overwrite-A'));
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.evaluate(() => { void window.__wireProbe!.overwrite(); });
        await page.evaluate(() => window.__wireProbe!.settled());
        assert.equal((await putCaptures(page)).length, 0, 'no A overwrite may dispatch while B is pending');
        const state = await probeState(page);
        assert.equal(state.content, 'BBB-content');
        assert.equal(state.path, 'b.md');
    } finally {
        resetBehaviors();
    }
});

test('071: a stale overwrite failure creates no error state after navigation', async t => {
    const page = await openHarness(t);
    if (!page) return;
    putBehavior = { status: 500, body: { ok: false, error: 'boom-overwrite' }, delayMs: 700 };
    try {
        await page.evaluate(() => window.__wireProbe!.load('a.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('overwrite-A'));
        await page.evaluate(() => { void window.__wireProbe!.overwrite(); });
        await page.waitForTimeout(150);
        await page.evaluate(() => { void window.__wireProbe!.load('b.md'); });
        await page.evaluate(() => window.__wireProbe!.settled());
        const state = await probeState(page);
        assert.equal(state.content, 'BBB-content');
        assert.equal(state.error, '', 'stale overwrite failure must not surface an error');
    } finally {
        resetBehaviors();
    }
});

test('071: a failed current load clears the pending guard so saving resumes', async t => {
    const page = await openHarness(t);
    if (!page) return;
    getBehaviors['a.md'] = { status: 500, body: { ok: false, error: 'boom-A' } };
    try {
        await page.evaluate(() => { void window.__wireProbe!.load('a.md'); });
        await page.evaluate(() => window.__wireProbe!.settled());
        assert.match((await probeState(page)).error, /boom-A|500/, 'current failure surfaces its error');

        // The pending guard cleared: a subsequent save on a fresh document dispatches.
        getBehaviors['b.md'] = { body: NOTE_B };
        await page.evaluate(() => window.__wireProbe!.load('b.md'));
        await page.evaluate(() => window.__wireProbe!.settled());
        await page.evaluate(() => window.__wireProbe!.edit('edited-B'));
        await page.evaluate(() => { void window.__wireProbe!.save(); });
        await page.evaluate(() => window.__wireProbe!.settled());
        assert.equal((await putCaptures(page)).length, 1, 'save dispatches again after the failed load cleared');
        assert.equal((await probeState(page)).revision, 'r2');
    } finally {
        resetBehaviors();
    }
});
