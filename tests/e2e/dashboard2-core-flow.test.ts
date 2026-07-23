import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launchBrowser(): Promise<Browser> {
    for (const launch of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try { const browser = await launch(); browsers.push(browser); return browser; } catch { /* next local executable */ }
    }
    throw new Error('dashboard2 e2e requires a local Chrome/Chromium executable');
}

async function startVite(): Promise<string> {
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen(); servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('Vite failed to bind');
    return `http://127.0.0.1:${address.port}`;
}

async function openHarness(browser: Browser, origin: string): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(window, '__name', { configurable: true, value: (fn: unknown) => fn }); });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({
        contentType: 'application/javascript',
        body: 'import { mountE2EAppHarness } from "/dist/dashboard2/src/dev/e2e-app-harness.tsx"; mountE2EAppHarness(document.querySelector("#dashboard2-root"), { historyCount: 10000 });',
    }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('.d2-shell').waitFor();
    await page.getByTestId('chat-view').waitFor();
    await page.locator('.d2-turn-slot').first().waitFor({ timeout: 30_000 });
    return page;
}

function lifecycle(event: 'turn_start' | 'turn_end', turnId: string, turnSeq: number, status: 'running' | 'done') {
    const createdAt = 1_783_100_000_000 + turnSeq;
    return { topic: 'agent', event, turnId, turnSeq, segmentId: `${turnId}:${event}`, sessionId: 'wp4-e2e-session', createdAt, observedAt: createdAt, providerAt: null, fidelity: 'full', thinkingMarker: null, type: event, status, detailRef: null };
}

test('full app boot, 10k history, stream/reload, SidePane identity, responsive resize, and SSE generation race', { timeout: 300_000 }, async () => {
    const harnessSource = readFileSync(join(ROOT, 'public/dashboard2/src/dev/e2e-app-harness.tsx'), 'utf8');
    const sidePaneSource = readFileSync(join(ROOT, 'public/dashboard2/src/shell/SidePane.tsx'), 'utf8');
    assert.doesNotMatch(harnessSource, /from ['"][^'"]*\/code\//, 'common harness code must not eagerly import Code');
    assert.match(sidePaneSource, /lazy\(\(\) => import\('\.\.\/code\/index\.ts'\)\)/, 'Code stays behind the production lazy boundary');
    const browser = await launchBrowser();
    const page = await openHarness(browser, await startVite());
    const initial = await page.evaluate(() => window.__jawE2E.diagnostics());
    assert.equal(initial.selected, '3506/wp4-e2e-session');
    assert.ok(initial.turnDomCount > 0 && initial.turnDomCount < initial.turnStoreWindowCap, `virtual window ${initial.turnDomCount} < ${initial.turnStoreWindowCap}`);
    assert.ok(initial.transcriptEntries > 100_000, '10k production history produced a virtual transcript');

    await page.getByRole('textbox', { name: 'Message' }).fill('WP4 streamed message');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.evaluate((start) => {
        window.__jawE2E.sse.emit('/i/3506/api/events', { topic: 'queue', event: 'queue_update', queued: [{ id: 'pending-1', prompt: 'WP4 streamed message', source: 'queued', status: 'pending' }] });
        window.__jawE2E.sse.emit('/i/3506/api/events', start);
    }, lifecycle('turn_start', 'wp4-live-turn', 1, 'running'));
    await page.getByRole('region', { name: 'Pending messages' }).waitFor();
    await page.getByTestId('live-turn-tail').waitFor();
    await page.evaluate(() => window.__jawE2E.sse.emit('/i/3506/api/events', { topic: 'agent', event: 'agent_output', traceRunId: 'wp4-trace', text: 'streaming body' }));
    await page.evaluate((end) => {
        window.__jawE2E.sse.emit('/i/3506/api/events', { topic: 'agent', event: 'agent_done', traceRunId: 'wp4-trace', text: 'streaming body' });
        window.__jawE2E.sse.emit('/i/3506/api/events', end);
        window.__jawE2E.sse.emit('/i/3506/api/events', { topic: 'queue', event: 'queue_update', queued: [] });
    }, lifecycle('turn_end', 'wp4-live-turn', 2, 'done'));
    await page.locator('[data-turn-id="wp4-live-turn"][data-terminal="done"]').waitFor();

    const parityBefore = await page.locator('[data-msg-id]').last().innerText();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('chat-view').waitFor();
    await page.locator('.d2-turn-slot').first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-msg-id]').last().innerText(), parityBefore, 'history parity survives a full reload');

    await page.evaluate(() => {
        for (const type of ['terminal', 'browser', 'files', 'code', 'notes'] as const) window.__jawE2E.openPanel(type, type === 'terminal' || type === 'browser' || type === 'notes');
    });
    await page.locator('.d2-side-pane').waitFor();
    const firstTurnIdentity = await page.locator('.d2-turn-slot').first().evaluate(node => { (window as typeof window & { __wp4TurnNode?: Element }).__wp4TurnNode = node; return true; });
    assert.equal(firstTurnIdentity, true);

    for (const label of ['Terminal', 'Browser', 'Files', 'Code', 'Notes']) {
        const tab = page.getByRole('tab', { name: label, exact: true });
        await tab.click();
        const type = label.toLowerCase();
        const slot = page.locator(`.d2-side-pane-tab-slot[data-tab="${type}"]`);
        await slot.waitFor();
        assert.equal(await slot.getAttribute('aria-hidden'), 'false');
        assert.equal(await slot.getAttribute('inert'), null);
    }
    const stableBefore = await page.evaluate(() => window.__jawE2E.diagnostics());
    for (const label of ['Terminal', 'Browser', 'Files', 'Code', 'Notes']) await page.getByRole('tab', { name: label, exact: true }).click();
    const stableAfter = await page.evaluate(() => ({
        diagnostic: window.__jawE2E.diagnostics(),
        sameTurn: (window as typeof window & { __wp4TurnNode?: Element }).__wp4TurnNode === document.querySelector('.d2-turn-slot'),
    }));
    assert.equal(stableAfter.sameTurn, true, 'turn DOM identity survives SidePane switches');
    assert.equal(stableAfter.diagnostic.listeners, stableBefore.listeners, 'listener delta is zero after a stable traversal');
    assert.equal(stableAfter.diagnostic.documents, stableBefore.documents, 'document delta is zero after a stable traversal');

    await page.evaluate(() => window.__jawE2E.showPicker());
    await page.getByRole('heading', { name: 'Open panel' }).waitFor();
    assert.equal(await page.locator('.d2-side-pane-picker-section').filter({ hasText: 'Tools' }).locator('[data-tab="terminal"], [data-tab="browser"], [data-tab="files"], [data-tab="code"]').count(), 4);
    assert.equal(await page.locator('.d2-side-pane-picker-section').filter({ hasText: 'Features' }).locator('[data-tab="notes"]').count(), 1);
    assert.equal(await page.locator('.d2-side-pane-picker-button[data-tab="settings"]').count(), 0, 'Settings is never a SidePane descriptor');

    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForFunction(() => document.querySelector('.d2-shell')?.classList.contains('d2-sb-closed'));
    assert.equal((await page.evaluate(() => window.__jawE2E.diagnostics())).selected, '3506/wp4-e2e-session');

    const oldGeneration = await page.evaluate(() => window.__jawE2E.sse.disconnect('/i/3506/api/events'));
    await page.waitForFunction(previous => window.__jawE2E.sse.generation('/i/3506/api/events') > previous, oldGeneration, { timeout: 5_000 });
    await page.evaluate((stale) => window.__jawE2E.sse.emitStale(stale), lifecycle('turn_start', 'stale-generation-turn', 1, 'running'));
    await page.evaluate((fresh) => window.__jawE2E.sse.emit('/i/3506/api/events', fresh, 'fresh-generation'), lifecycle('turn_start', 'fresh-generation-turn', 1, 'running'));
    await page.locator('[data-testid="live-turn-tail"] [data-turn-id="fresh-generation-turn"]').waitFor();
    assert.equal(await page.locator('[data-turn-id="stale-generation-turn"]').count(), 0, 'stale generation cannot overwrite the live store');
});
