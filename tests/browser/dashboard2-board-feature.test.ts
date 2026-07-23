import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    await Promise.allSettled(servers.map((server) => server.close()));
});

type ServerLane = 'backlog' | 'ready' | 'active' | 'review' | 'done';

interface ServerTask {
    id: string;
    title: string;
    summary: string | null;
    detail: string | null;
    lane: ServerLane;
    source: string;
    createdAt: string;
    updatedAt: string;
}

function task(id: string, title: string, lane: ServerLane = 'backlog'): ServerTask {
    return {
        id,
        title,
        summary: null,
        detail: null,
        lane,
        source: 'user',
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
    };
}

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

async function fulfill(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('072 Board CRUD, keyboard lane move, and PATCH 500 rollback', { timeout: 120_000 }, async (t) => {
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

    const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    contexts.push(context);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const requests: Array<{ method: string; id: string | null; body: Record<string, unknown> | null }> = [];
    let tasks = [task('seed-task', 'Keyboard task')];
    let nextId = 1;
    let failNextPatch = false;
    let signalFailingPatch: (() => void) | null = null;
    let releaseFailingPatch: (() => void) | null = null;
    const failingPatchStarted = new Promise<void>((resolve) => { signalFailingPatch = resolve; });

    page.on('console', (entry) => { if (entry.type() === 'error') consoleErrors.push(entry.text()); });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await page.route('**/api/dashboard/board/tasks**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const basePath = '/api/dashboard/board/tasks';
        const id = url.pathname === basePath ? null : decodeURIComponent(url.pathname.slice(`${basePath}/`.length));
        const body = request.postDataJSON() as Record<string, unknown> | null;
        requests.push({ method, id, body });
        if (url.pathname === basePath && method === 'GET') return fulfill(route, { ok: true, tasks });
        if (url.pathname === basePath && method === 'POST') {
            const created = task(`created-${nextId++}`, String(body?.title ?? ''), body?.lane as ServerLane);
            tasks = [created, ...tasks];
            return fulfill(route, { ok: true, task: created }, 201);
        }
        const existing = tasks.find((item) => item.id === id);
        if (!existing) return fulfill(route, { ok: false, error: 'not found' }, 404);
        if (method === 'PATCH') {
            if (failNextPatch) {
                failNextPatch = false;
                signalFailingPatch?.();
                await new Promise<void>((resolve) => { releaseFailingPatch = resolve; });
                return fulfill(route, { ok: false, error: 'Injected PATCH failure' }, 500);
            }
            const updated = {
                ...existing,
                ...(typeof body?.title === 'string' ? { title: body.title } : {}),
                ...(typeof body?.summary === 'string' || body?.summary === null ? { summary: body.summary as string | null } : {}),
                ...(typeof body?.detail === 'string' || body?.detail === null ? { detail: body.detail as string | null } : {}),
                ...(typeof body?.lane === 'string' ? { lane: body.lane as ServerLane } : {}),
                updatedAt: '2026-07-23T00:01:00.000Z',
            };
            tasks = tasks.map((item) => item.id === id ? updated : item);
            return fulfill(route, { ok: true, task: updated });
        }
        if (method === 'DELETE') {
            tasks = tasks.filter((item) => item.id !== id);
            return fulfill(route, { ok: true });
        }
        return fulfill(route, { ok: false, error: 'unexpected request' }, 500);
    });
    await page.route('**/dashboard2/src/main.tsx*', (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/features/board/BoardPanelHarness.tsx');
        module.mountBoardPanelHarness(target);
    });

    await page.getByText('Keyboard task', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create task' }).click();
    await page.getByLabel('Title').fill('Created task');
    await page.getByLabel('Lane').selectOption('todo');
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByText('Created task', { exact: true }).waitFor();

    await page.locator('[data-board-task-id="created-1"]').click();
    const editor = page.getByRole('dialog', { name: 'Edit task' });
    await editor.getByLabel('Title').fill('Edited task');
    await editor.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Edited task', { exact: true }).waitFor();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Delete Edited task' }).click();
    await page.getByText('Edited task', { exact: true }).waitFor({ state: 'detached' });

    const seedCard = page.locator('[data-board-task-id="seed-task"]');
    await seedCard.press('Space');
    await seedCard.press('ArrowRight');
    await seedCard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-board-task-id="seed-task"] [data-status="todo"]') !== null);
    assert.equal(requests.filter((entry) => entry.id === 'seed-task' && entry.method === 'PATCH').at(-1)?.body?.lane, 'ready');

    failNextPatch = true;
    await seedCard.press('Space');
    await seedCard.press('ArrowRight');
    await seedCard.press('Enter');
    await failingPatchStarted;
    assert.equal(await seedCard.locator('[data-status="in_progress"]').count(), 1, 'optimistic lane is visible while PATCH is pending');
    releaseFailingPatch?.();
    await page.getByRole('alert').getByText('Injected PATCH failure', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-board-task-id="seed-task"] [data-status="todo"]') !== null);
    assert.equal(await seedCard.locator('[data-status="todo"]').count(), 1, 'failed PATCH restores the previous lane');

    assert.deepEqual(requests.filter((entry) => entry.id !== 'seed-task' && entry.method !== 'GET').map((entry) => entry.method), ['POST', 'PATCH', 'DELETE']);
    assert.equal(requests.filter((entry) => entry.id === 'seed-task' && entry.method === 'PATCH').length, 2);
    const expectedInjectedFailures = consoleErrors.filter((entry) => /Failed to load resource.*500/.test(entry));
    const unexpectedErrors = consoleErrors.filter((entry) => !/Failed to load resource.*500/.test(entry));
    assert.equal(expectedInjectedFailures.length, 1, 'the injected PATCH 500 is the only expected browser error');
    assert.equal(unexpectedErrors.length, 0, unexpectedErrors.join('\n'));
});
