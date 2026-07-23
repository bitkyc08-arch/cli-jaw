import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    await Promise.allSettled(servers.map((server) => server.close()));
});

interface TestScheduleItem {
    id: string;
    title: string;
    group: 'today' | 'upcoming' | 'recurring' | 'blocked';
    cron: string | null;
    runAt: string | null;
    targetPort: number | null;
    payload: string | null;
    enabled: boolean;
    lastRunAt: string | null;
    lastStatus: string | null;
    nextRunAt: string | null;
    createdAt: string;
    updatedAt: string;
}

interface HarnessWindow extends Window {
    __scheduleUnmount?: () => void;
    __scheduleHarness?: {
        setActive(active: boolean): void;
        setDispatchStatus(status: 'disabled' | 'no_target' | 'queued' | 'dispatched' | 'claim-changed'): void;
        metrics(): { listCalls: number; dispatchCalls: number; claimChangedFixtureCalls: number };
        unmount(): void;
    };
    __scheduleTimerProbe?: {
        fireAll(): void;
        snapshot(): { intervals: number; visibilityListeners: number };
    };
}

function scheduleItem(id: string, title: string, patch: Partial<TestScheduleItem> = {}): TestScheduleItem {
    const now = '2026-07-23T00:00:00.000Z';
    return {
        id,
        title,
        group: 'upcoming',
        cron: null,
        runAt: null,
        targetPort: null,
        payload: null,
        enabled: true,
        lastRunAt: null,
        lastStatus: null,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
        ...patch,
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

test('073 Schedule CRUD, five dispatch decisions, and inactive polling lifecycle', { timeout: 120_000 }, async (t) => {
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

    const context = await browser.newContext({ viewport: { width: 760, height: 720 } });
    contexts.push(context);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let items: TestScheduleItem[] = [];
    page.on('console', (entry) => { if (entry.type() === 'error') consoleErrors.push(entry.text()); });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await page.route('**/api/dashboard/schedule/work**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const body = request.postDataJSON() as Record<string, unknown> | null;
        requests.push({ method, url: url.pathname, body });
        const basePath = '/api/dashboard/schedule/work';
        if (url.pathname === basePath && method === 'GET') return fulfill(route, { ok: true, items });
        if (url.pathname === basePath && method === 'POST') {
            const created = scheduleItem('http-created', String(body?.title ?? ''), {
                group: body?.group as TestScheduleItem['group'],
                cron: typeof body?.cron === 'string' ? body.cron : null,
                runAt: typeof body?.runAt === 'string' ? body.runAt : null,
                targetPort: typeof body?.targetPort === 'number' ? body.targetPort : null,
                payload: typeof body?.payload === 'string' ? body.payload : null,
                enabled: body?.enabled !== false,
            });
            items = [created, ...items];
            return fulfill(route, { ok: true, item: created }, 201);
        }
        const id = decodeURIComponent(url.pathname.slice(`${basePath}/`.length));
        const existing = items.find((item) => item.id === id);
        if (!existing) return fulfill(route, { ok: false, error: 'not found' }, 404);
        if (method === 'PATCH') {
            const updated = { ...existing, ...body, updatedAt: '2026-07-23T00:01:00.000Z' } as TestScheduleItem;
            items = items.map((item) => item.id === id ? updated : item);
            return fulfill(route, { ok: true, item: updated });
        }
        if (method === 'DELETE') {
            items = items.filter((item) => item.id !== id);
            return fulfill(route, { ok: true });
        }
        return fulfill(route, { ok: false, error: 'unexpected request' }, 500);
    });
    await page.route('**/dashboard2/src/main.tsx*', (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/features/reminders/ScheduleViewHarness.tsx');
        (window as HarnessWindow).__scheduleUnmount = module.mountScheduleHttpHarness(target);
    });

    await page.getByRole('heading', { name: 'Scheduled work' }).waitFor();
    const createButton = page.getByRole('button', { name: 'Create scheduled work' });
    await createButton.click();
    const createDialog = page.getByRole('dialog', { name: 'New scheduled work' });
    assert.equal(await createDialog.getByRole('button', { name: 'Add' }).isDisabled(), true, 'empty create is rejected');
    await createDialog.getByLabel('Title').fill('Browser-created schedule');
    await createDialog.getByLabel('Group').selectOption('recurring');
    await createDialog.getByLabel('Target port').fill('3506');
    await createDialog.getByLabel('Cron').fill('0 9 * * 1-5');
    await createDialog.getByRole('button', { name: 'Add' }).click();
    await page.getByText('Browser-created schedule', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Edit scheduled work Browser-created schedule' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit scheduled work' });
    await editDialog.getByLabel('Title').fill('Browser-updated schedule');
    await editDialog.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Browser-updated schedule', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Edit scheduled work Browser-updated schedule' }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('dialog', { name: 'Edit scheduled work' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByText('Browser-updated schedule', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(requests.filter((entry) => entry.method !== 'GET').map((entry) => entry.method), ['POST', 'PATCH', 'DELETE']);
    assert.equal((requests.find((entry) => entry.method === 'POST')?.body as { targetPort?: number }).targetPort, 3506);

    await page.evaluate(() => {
        (window as HarnessWindow).__scheduleUnmount?.();
        const callbacks = new Map<number, TimerHandler>();
        let nextTimer = 1;
        window.setInterval = ((handler: TimerHandler) => {
            const id = nextTimer++;
            callbacks.set(id, handler);
            return id;
        }) as typeof window.setInterval;
        window.clearInterval = ((id?: number) => { if (id !== undefined) callbacks.delete(id); }) as typeof window.clearInterval;
        const visibilityListeners = new Set<EventListenerOrEventListenerObject>();
        const add = document.addEventListener.bind(document);
        const remove = document.removeEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
            if (type === 'visibilitychange') visibilityListeners.add(listener);
            add(type, listener, options);
        }) as typeof document.addEventListener;
        document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
            if (type === 'visibilitychange') visibilityListeners.delete(listener);
            remove(type, listener, options);
        }) as typeof document.removeEventListener;
        (window as HarnessWindow).__scheduleTimerProbe = {
            fireAll() {
                for (const callback of [...callbacks.values()]) {
                    if (typeof callback === 'function') callback();
                }
            },
            snapshot() {
                return { intervals: callbacks.size, visibilityListeners: visibilityListeners.size };
            },
        };
    });
    await page.evaluate(async () => {
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/features/reminders/ScheduleViewHarness.tsx');
        (window as HarnessWindow).__scheduleHarness = module.mountScheduleFixtureHarness(target);
        (window as HarnessWindow).__scheduleHarness?.setActive(true);
    });
    await page.waitForFunction(() => ((window as HarnessWindow).__scheduleHarness?.metrics().listCalls ?? 0) >= 1);
    assert.deepEqual(await page.evaluate(() => (window as HarnessWindow).__scheduleTimerProbe?.snapshot()), { intervals: 1, visibilityListeners: 1 });

    const dispatchCases = [
        ['disabled', 'Dispatch 판정: 비활성'],
        ['no_target', 'Dispatch 판정: 대상 없음'],
        ['queued', 'Dispatch 판정: 대기열 유지'],
        ['dispatched', 'Dispatch 판정: 전달 준비 · claim 완료'],
        ['claim-changed', 'Dispatch 판정: claim 변경 감지'],
    ] as const;
    for (const [status, label] of dispatchCases) {
        await page.evaluate((nextStatus) => (window as HarnessWindow).__scheduleHarness?.setDispatchStatus(nextStatus), status);
        await page.getByRole('button', { name: 'Dispatch 판정: Fixture scheduled work' }).click();
        await page.locator(`[data-dispatch-status="${status}"]`).waitFor();
        assert.equal(await page.getByText(label, { exact: true }).count(), 1, `${status} has a distinct UI label`);
    }
    const fixtureMetrics = await page.evaluate(() => (window as HarnessWindow).__scheduleHarness?.metrics());
    assert.deepEqual(fixtureMetrics, { listCalls: 1, dispatchCalls: 5, claimChangedFixtureCalls: 1 });
    assert.equal(requests.filter((entry) => entry.url.endsWith('/dispatch')).length, 0, 'claim-changed used the injected adapter fixture, not double HTTP dispatch');

    await page.evaluate(() => (window as HarnessWindow).__scheduleHarness?.setActive(false));
    await page.waitForFunction(() => (window as HarnessWindow).__scheduleTimerProbe?.snapshot().intervals === 0);
    const callsWhileInactive = await page.evaluate(() => (window as HarnessWindow).__scheduleHarness?.metrics().listCalls ?? -1);
    await page.evaluate(() => (window as HarnessWindow).__scheduleTimerProbe?.fireAll());
    assert.equal(await page.evaluate(() => (window as HarnessWindow).__scheduleHarness?.metrics().listCalls), callsWhileInactive, 'inactive tab has no poll callback');
    assert.deepEqual(await page.evaluate(() => (window as HarnessWindow).__scheduleTimerProbe?.snapshot()), { intervals: 0, visibilityListeners: 0 });

    await page.evaluate(() => (window as HarnessWindow).__scheduleHarness?.setActive(true));
    await page.waitForFunction((before) => ((window as HarnessWindow).__scheduleHarness?.metrics().listCalls ?? 0) > before, callsWhileInactive);
    await page.evaluate(() => (window as HarnessWindow).__scheduleTimerProbe?.fireAll());
    await page.waitForFunction((before) => ((window as HarnessWindow).__scheduleHarness?.metrics().listCalls ?? 0) > before + 1, callsWhileInactive);
    assert.deepEqual(await page.evaluate(() => (window as HarnessWindow).__scheduleTimerProbe?.snapshot()), { intervals: 1, visibilityListeners: 1 });

    await page.evaluate(() => (window as HarnessWindow).__scheduleHarness?.unmount());
    assert.deepEqual(await page.evaluate(() => (window as HarnessWindow).__scheduleTimerProbe?.snapshot()), { intervals: 0, visibilityListeners: 0 }, 'listener/timer delta is zero after teardown');
    assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
});
