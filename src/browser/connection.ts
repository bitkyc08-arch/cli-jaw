import { JAW_HOME, deriveCdpPort, settings } from '../core/config.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'path';
import fs from 'node:fs';
import net from 'node:net';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import { resolveLaunchPolicy, type BrowserStartMode } from './launch-policy.js';
import os from 'node:os';
import {
    browserReaperIntervalMs,
    createEmptyBrowserRuntime,
    createExternalBrowserRuntime,
    createJawOwnedBrowserRuntime,
    decideBrowserCloseAction,
    shouldCloseIdleRuntime,
    type BrowserRuntimeOwner,
    type BrowserRuntimeStatus,
} from './runtime-owner.js';
import { clearDurableBrowserRuntimeOwner, writeDurableBrowserRuntimeOwner } from './runtime-owner-store.js';

const PROFILE_DIR = join(JAW_HOME, 'browser-profile');
const TAB_ACTIVITY_FILE = join(JAW_HOME, 'browser-tab-activity.json');
type BrowserConnectionCache = { browser: Browser; cdpUrl: string };
type JsonRecord = Record<string, unknown>;
type BrowserCdpSession = Pick<CDPSession, 'send' | 'detach'> | RawBrowserCdpSession;
type RawBrowserCdpSession = {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    detach(): Promise<void>;
};

let cached: BrowserConnectionCache | null = null;
let chromeProc: ChildProcess | null = null;
let activePort: number | null = null;
let runtimeOwner: BrowserRuntimeOwner | null = null;
let activeCommandCount = 0;
let idleReaper: ReturnType<typeof setInterval> | null = null;
let verifiedActiveTargetId: string | null = null;
let browserStateVersion = 0;
const tabActivity = new Map<string, number>();
let tabActivityLoaded = false;

export interface BrowserTabInfo {
    tabId: string;
    targetId: string;
    index: number;
    title: string;
    url: string;
    type: string;
    active: boolean;
    attached: boolean;
    lastActiveAt?: number | null;
}

export interface ActiveTabResult {
    ok: boolean;
    tab?: BrowserTabInfo;
    reason?: 'none' | 'ambiguous' | 'unverified' | 'not-found';
}

type RawCdpTab = {
    id?: string;
    title?: string;
    url?: string;
    type?: string;
};

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? '');
}

function requireTargetId(value: unknown): { targetId: string } {
    if (isRecord(value) && typeof value.targetId === 'string') return { targetId: value.targetId };
    throw new Error('CDP response missing targetId');
}

function targetInfoMatches(value: unknown, targetId: string): boolean {
    if (!isRecord(value) || !isRecord(value.targetInfo)) return false;
    return value.targetInfo.targetId === targetId;
}

export function markBrowserStateChanged() {
    browserStateVersion++;
}

export function getBrowserStateVersion() {
    return browserStateVersion;
}

function loadTabActivity(): void {
    if (tabActivityLoaded) return;
    tabActivityLoaded = true;
    if (!fs.existsSync(TAB_ACTIVITY_FILE)) return;
    try {
        const parsed = JSON.parse(fs.readFileSync(TAB_ACTIVITY_FILE, 'utf8')) as { tabs?: Record<string, number> };
        for (const [targetId, lastActiveAt] of Object.entries(parsed.tabs || {})) {
            if (targetId && Number.isFinite(lastActiveAt)) tabActivity.set(targetId, lastActiveAt);
        }
    } catch {
        tabActivity.clear();
    }
}

function saveTabActivity(): void {
    fs.mkdirSync(JAW_HOME, { recursive: true });
    fs.writeFileSync(TAB_ACTIVITY_FILE, `${JSON.stringify({ tabs: Object.fromEntries(tabActivity.entries()) }, null, 2)}\n`);
}

export function markTabActive(targetId: string | null | undefined, at = Date.now()): number | null {
    if (!targetId) return null;
    loadTabActivity();
    tabActivity.set(targetId, at);
    saveTabActivity();
    return at;
}

export function forgetTabActivity(targetId: string | null | undefined): void {
    if (!targetId) return;
    loadTabActivity();
    tabActivity.delete(targetId);
    saveTabActivity();
}

export function getTabActivity(targetId: string | null | undefined): number | null {
    if (!targetId) return null;
    loadTabActivity();
    return tabActivity.get(targetId) || null;
}

/** Check if a port is already listening via TCP connect */
function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise(resolve => {
        const sock = net.createConnection({ port, host });
        const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 500);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
        sock.once('error', () => { clearTimeout(timer); resolve(false); });
    });
}

/** Poll CDP /json/version until Chrome is ready to accept CDP connections */
async function waitForCdpReady(port: number, timeoutMs = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
                signal: AbortSignal.timeout(2000),
            });
            if (resp.ok) return true;
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

async function resetStaleChromeProcIfCdpUnavailable(port: number): Promise<boolean> {
    if (!chromeProc || chromeProc.killed) return false;
    if (await waitForCdpReady(port, 1000)) return false;
    try {
        chromeProc.kill('SIGTERM');
    } catch {
        // The process may have already exited between the killed check and SIGTERM.
    }
    chromeProc = null;
    if (runtimeOwner?.ownership === 'jaw-owned') {
        clearDurableBrowserRuntimeOwner(runtimeOwner);
        runtimeOwner = null;
        activePort = null;
        verifiedActiveTargetId = null;
        disconnectLocalBrowserCache();
        markBrowserStateChanged();
    }
    return true;
}

function isWSL() {
    if (process.platform !== 'linux') return false;
    try {
        return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    } catch {
        return false;
    }
}

function findChrome() {
    const platform = process.platform;
    const paths: string[] = [];

    if (platform === 'darwin') {
        paths.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        );
    } else if (platform === 'win32') {
        const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
        const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const local = process.env.LOCALAPPDATA || '';
        paths.push(
            `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
            `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
            `${local}\\Google\\Chrome\\Application\\chrome.exe`,
            `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        );
    } else {
        paths.push(
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/brave-browser',
        );
        if (isWSL()) {
            paths.push(
                '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
                '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
            );
        }
    }

    for (const p of paths) {
        if (p && fs.existsSync(p)) return p;
    }
    throw new Error('Chrome not found — install Google Chrome');
}

function touchBrowserRuntime(): void {
    if (!runtimeOwner) return;
    runtimeOwner = { ...runtimeOwner, lastUsedAt: new Date().toISOString() };
}

export function beginBrowserActivity(): () => void {
    activeCommandCount++;
    touchBrowserRuntime();
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        activeCommandCount = Math.max(0, activeCommandCount - 1);
        touchBrowserRuntime();
    };
}

export async function withBrowserActivity<T>(fn: () => Promise<T>): Promise<T> {
    const end = beginBrowserActivity();
    try {
        return await fn();
    } finally {
        end();
    }
}

function readProcessCommandLine(pid: number): Promise<string | null> {
    if (process.platform === 'win32') {
        const pidText = String(Math.trunc(pid));
        return new Promise((resolve) => {
            execFile('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pidText}").CommandLine`,
            ], (psError, psStdout) => {
                const psCommand = psStdout.trim();
                if (!psError && psCommand) {
                    resolve(psCommand);
                    return;
                }
                execFile('wmic.exe', ['process', 'where', `ProcessId=${pidText}`, 'get', 'CommandLine', '/value'], (wmicError, wmicStdout) => {
                    if (wmicError) {
                        resolve(null);
                        return;
                    }
                    const command = wmicStdout
                        .split(/\r?\n/)
                        .find((line) => line.startsWith('CommandLine='))
                        ?.slice('CommandLine='.length)
                        .trim();
                    resolve(command || null);
                });
            });
        });
    }
    if (process.platform === 'linux') {
        try {
            return Promise.resolve(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim());
        } catch {
            return Promise.resolve(null);
        }
    }
    return new Promise((resolve) => {
        execFile('ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            resolve(stdout.trim() || null);
        });
    });
}

async function isRecordedChromeStillOwned(owner: BrowserRuntimeOwner | null): Promise<boolean> {
    if (!owner || owner.ownership !== 'jaw-owned') return false;
    if (!owner.pid || !owner.port || !owner.userDataDir) return false;
    const command = await readProcessCommandLine(owner.pid);
    if (!command) return false;
    return command.includes(`--remote-debugging-port=${owner.port}`)
        && command.includes(`--user-data-dir=${owner.userDataDir}`);
}

function disconnectLocalBrowserCache(): void {
    cached = null;
}

async function closeOwnedChrome(reason: 'manual' | 'idle'): Promise<boolean> {
    const owner = runtimeOwner;
    const proofOk = await isRecordedChromeStillOwned(owner);
    const action = decideBrowserCloseAction(owner, reason, proofOk);
    if (action === 'disconnect-only') {
        disconnectLocalBrowserCache();
        return true;
    }
    if (action !== 'close-owned') return false;

    if (cached?.browser) {
        await cached.browser.close().catch(() => undefined);
        cached = null;
    }
    if (chromeProc && !chromeProc.killed) {
        chromeProc.kill('SIGTERM');
    } else if (owner?.pid) {
        try {
            process.kill(owner.pid, 'SIGTERM');
        } catch {
            // Process already exited or proof was stale after verification.
        }
    }
    chromeProc = null;
    clearDurableBrowserRuntimeOwner(owner);
    runtimeOwner = null;
    activePort = null;
    verifiedActiveTargetId = null;
    markBrowserStateChanged();
    return true;
}

async function closeIfIdle(): Promise<void> {
    if (!shouldCloseIdleRuntime(runtimeOwner, Date.now(), activeCommandCount)) return;
    await closeOwnedChrome('idle');
}

function ensureIdleReaperStarted(): void {
    if (idleReaper) return;
    idleReaper = setInterval(() => {
        void closeIfIdle().catch((error) => {
            console.warn('[browser] idle auto-close failed', { error: (error as Error).message });
        });
    }, browserReaperIntervalMs());
    idleReaper.unref?.();
}

export async function launchChrome(
    port = deriveCdpPort(),
    opts: { headless?: boolean; mode?: BrowserStartMode } = {},
) {
    // 1. CDP already responding → reuse (covers server restart, external Chrome)
    if (await isPortListening(port)) {
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
                signal: AbortSignal.timeout(2000),
            });
            if (resp.ok) {
                console.warn(`[browser] warning: CDP port ${port} appears foreign — cli-jaw is attaching to an existing Chrome it did not start; verify --user-data-dir matches if you depend on profile state, and avoid sharing the same userDataDir between two CDP-controlled processes.`);
                console.log(`[browser] CDP already listening on port ${port} — reusing existing instance`);
                activePort = port;
                runtimeOwner = createExternalBrowserRuntime(port);
                ensureIdleReaperStarted();
                return;
            }
        } catch {
            throw new Error(
                `Port ${port} is in use but not responding as CDP. ` +
                `Another process may be occupying the port. Try --port <other> or stop the conflicting process.`
            );
        }
    }

    if (chromeProc && !chromeProc.killed) {
        const reset = await resetStaleChromeProcIfCdpUnavailable(port);
        if (!reset) return;
    }

    const launchPolicy = resolveLaunchPolicy({
        mode: opts.mode,
        headless: opts.headless,
    });
    if (!launchPolicy.allowLaunch) {
        throw new Error(launchPolicy.denyReason || 'Browser launch denied by policy');
    }

    const chrome = findChrome();
    const noSandbox = process.env.CHROME_NO_SANDBOX === '1';
    const headless = launchPolicy.headless;

    // Minimum window size to prevent responsive layout shifts
    // that cause Playwright "element is not stable" errors
    const minWidth = 1280;
    const minHeight = 720;

    chromeProc = spawn(chrome, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE_DIR}`,
        `--window-size=${minWidth},${minHeight}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
        ...(headless ? ['--headless=new'] : []),
        'about:blank',
    ], { detached: true, stdio: 'ignore' });
    chromeProc.unref();

    // 2. CDP readiness polling (replaces blind 2s sleep)
    const ready = await waitForCdpReady(port);
    if (ready) {
        activePort = port;
        const owner = createJawOwnedBrowserRuntime({
            port,
            pid: chromeProc.pid ?? null,
            userDataDir: PROFILE_DIR,
            headless,
        });
        runtimeOwner = owner;
        writeDurableBrowserRuntimeOwner(owner);
        ensureIdleReaperStarted();
    } else {
        if (chromeProc && !chromeProc.killed) {
            chromeProc.kill('SIGTERM');
            chromeProc = null;
        }
        throw new Error(
            `Chrome CDP not responding on port ${port} after 10s. ` +
            `Possible causes:\n` +
            `  - Windows: Chrome singleton absorbed the launch (close ALL Chrome windows first)\n` +
            `  - No display available (try --headless or CHROME_HEADLESS=1)\n` +
            `  - Port conflict (try --port <other>)`
        );
    }
}

/** Resolve effective CDP port: activePort > settings.browser.cdpPort > deriveCdpPort() */
export function getActivePort(): number {
    return activePort || settings.browser?.cdpPort || deriveCdpPort();
}

export async function connectCdp(port = getActivePort(), retries = 3) {
    const cdpUrl = `http://127.0.0.1:${port}`;
    if (cached?.cdpUrl === cdpUrl && cached.browser.isConnected()) return cached;

    let lastError: Error | null = null;
    for (let i = 0; i < retries; i++) {
        try {
            const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10000 });
            cached = { browser, cdpUrl };
            browser.on('disconnected', () => { cached = null; });
            return cached;
        } catch (e) {
            lastError = e as Error;
            if (i < retries - 1) {
                console.warn(`[browser] CDP connect attempt ${i + 1}/${retries} failed, retrying in 1s...`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    throw new Error(`CDP connection failed after ${retries} attempts: ${lastError?.message}`);
}

export async function getActivePage(port = getActivePort()) {
    const { browser } = await connectCdp(port);
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (verifiedActiveTargetId) {
        const tabs = await readCdpPageTargets(port).catch(() => []);
        const tab = tabs.find((t) => t.id === verifiedActiveTargetId);
        if (tab) {
            for (const page of pages) {
                const title = await page.title().catch(() => '');
                if (page.url() === tab.url && title === (tab.title || '')) return page;
            }
        }
    }
    return pages[pages.length - 1] || null;
}

async function readCdpPageTargets(port = getActivePort()): Promise<RawCdpTab[]> {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
    return ((await resp.json()) as RawCdpTab[]).filter((t) => t.type === 'page');
}

function toBrowserTabInfo(tab: RawCdpTab, index: number, activeTargetId: string | null): BrowserTabInfo {
    const targetId = tab.id || '';
    return {
        tabId: targetId,
        targetId,
        index: index + 1,
        title: tab.title || '',
        url: tab.url || '',
        type: tab.type || 'page',
        active: Boolean(activeTargetId && targetId === activeTargetId),
        attached: true,
        lastActiveAt: getTabActivity(targetId),
    };
}

async function resolveActiveTargetId(port: number, tabs: RawCdpTab[]): Promise<string | null> {
    if (verifiedActiveTargetId && tabs.some((t) => t.id === verifiedActiveTargetId)) {
        return verifiedActiveTargetId;
    }
    return null;
}

export async function listTabs(port = getActivePort()): Promise<BrowserTabInfo[]> {
    const tabs = await readCdpPageTargets(port);
    const activeTargetId = await resolveActiveTargetId(port, tabs);
    return tabs.map((tab, index) => toBrowserTabInfo(tab, index, activeTargetId));
}

export async function getActiveTab(port = getActivePort()): Promise<ActiveTabResult> {
    const tabs = await listTabs(port);
    const active = tabs.filter((t) => t.active);
    if (active.length === 0) return { ok: false, reason: 'none' };
    if (active.length > 1) return { ok: false, reason: 'ambiguous' };
    return { ok: true, tab: active[0] };
}

export async function switchTab(port = getActivePort(), target: string): Promise<ActiveTabResult> {
    const tabs = await readCdpPageTargets(port);
    const wantedIndex = Number(target);
    const wanted = Number.isInteger(wantedIndex)
        ? tabs[wantedIndex - 1]
        : tabs.find((t) => t.id === target);
    if (!wanted?.id) return { ok: false, reason: 'not-found' };

    const { browser } = await connectCdp(port);
    const cdp = await browser.newBrowserCDPSession();
    try {
        await cdp.send('Target.activateTarget', { targetId: wanted.id });
    } finally {
        await cdp.detach().catch(() => undefined);
    }
    verifiedActiveTargetId = wanted.id;
    markTabActive(wanted.id);
    markBrowserStateChanged();
    const active = await getActiveTab(port);
    if (!active.ok || active.tab?.targetId !== wanted.id) return { ok: false, reason: 'unverified' };
    return active;
}

export async function getBrowserStatus(port = getActivePort()) {
    try {
        const tabs = await listTabs(port);
        return {
            running: true,
            tabs: tabs.length,
            cdpUrl: `http://127.0.0.1:${port}`,
            runtime: getBrowserRuntimeStatus(),
        };
    } catch { return { running: false, tabs: 0, runtime: getBrowserRuntimeStatus() }; }
}

export function getBrowserRuntimeStatus(): BrowserRuntimeStatus {
    return runtimeOwner
        ? { ...runtimeOwner, activeCommandCount }
        : createEmptyBrowserRuntime(activeCommandCount);
}

export async function getCdpSession(port = getActivePort()): Promise<BrowserCdpSession | null> {
    try {
        const page = await getActivePage(port);
        if (page) return page.context().newCDPSession(page);
        const { browser } = await connectCdp(port);
        if (typeof browser.newBrowserCDPSession === 'function') {
            return browser.newBrowserCDPSession();
        }
    } catch (error: unknown) {
        if (!errorMessage(error).includes('Browser.setDownloadBehavior')) throw error;
    }
    return createRawBrowserCdpSession(port);
}

async function createRawBrowserCdpSession(port: number): Promise<RawBrowserCdpSession | null> {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    const version = await response.json() as { webSocketDebuggerUrl?: string };
    const endpoint = version.webSocketDebuggerUrl;
    if (!endpoint || typeof WebSocket !== 'function') return null;
    const ws = new WebSocket(endpoint);
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    ws.addEventListener('message', event => {
        let payload: unknown = null;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (!isRecord(payload) || typeof payload.id !== 'number' || !pending.has(payload.id)) return;
        const callbacks = pending.get(payload.id)!;
        pending.delete(payload.id);
        const error = payload.error;
        if (isRecord(error)) callbacks.reject(new Error(typeof error.message === 'string' ? error.message : JSON.stringify(error)));
        else callbacks.resolve(payload.result || {});
    });
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('CDP websocket connection failed')), { once: true });
    });
    return {
        send(method: string, params: Record<string, unknown> = {}) {
            const id = nextId++;
            const promise = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
            ws.send(JSON.stringify({ id, method, params }));
            return promise;
        },
        async detach() {
            for (const { reject } of pending.values()) reject(new Error('CDP session detached'));
            pending.clear();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        },
    };
}

function isReusableBlankTab(tab: RawCdpTab, allTabs: RawCdpTab[] = []): boolean {
    const url = String(tab.url || '').toLowerCase();
    if (!tab.id || (url !== 'about:blank' && url !== '')) return false;
    return allTabs.length <= 1;
}

export async function createTab(port = getActivePort(), url = 'about:blank', opts: { activate?: boolean; reuseBlank?: boolean } = {}): Promise<{ targetId: string; url: string; title: string; activated: boolean; lastActiveAt: number | null; reusedBlank?: boolean }> {
    const cdp = await getCdpSession(port);
    if (!cdp) throw new Error('No CDP session available for tab creation');
    try {
        if (url !== 'about:blank' && opts.reuseBlank !== false) {
            const tabs = await readCdpPageTargets(port);
            const blank = tabs.find(tab => isReusableBlankTab(tab, tabs));
            if (blank?.id) {
                const page = await waitForPageByTargetId(port, blank.id);
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                if (opts.activate !== false) {
                    await cdp.send('Target.activateTarget', { targetId: blank.id });
                    verifiedActiveTargetId = blank.id;
                    markBrowserStateChanged();
                }
                const lastActiveAt = markTabActive(blank.id);
                const title = await page.title().catch(() => 'New Tab');
                return { targetId: blank.id, url: page.url(), title, activated: opts.activate !== false, lastActiveAt, reusedBlank: true };
            }
        }

        const { targetId } = await createTargetWithWindowFallback(cdp, url, opts);
        await new Promise(r => setTimeout(r, 100));
        const tabs = await readCdpPageTargets(port);
        const tab = tabs.find(t => t.id === targetId);
        const lastActiveAt = markTabActive(targetId);
        return { targetId, url: tab?.url || url, title: tab?.title || 'New Tab', activated: opts.activate !== false, lastActiveAt };
    } finally {
        await cdp.detach().catch(() => undefined);
    }
}

async function createTargetWithWindowFallback(cdp: BrowserCdpSession, url: string, opts: { activate?: boolean }): Promise<{ targetId: string }> {
    try {
        return requireTargetId(await cdp.send('Target.createTarget', { url, newWindow: false, background: !opts.activate }));
    } catch (error: unknown) {
        if (!errorMessage(error).includes('no browser is open')) throw error;
        return requireTargetId(await cdp.send('Target.createTarget', { url, newWindow: true, background: false }));
    }
}

export async function closeTab(port = getActivePort(), targetId: string): Promise<{ closed: boolean; targetId: string; alreadyClosed?: boolean }> {
    const cdp = await getCdpSession(port);
    if (!cdp) throw new Error('No CDP session available for tab close');
    try {
        await cdp.send('Target.closeTarget', { targetId });
        forgetTabActivity(targetId);
        return { closed: true, targetId };
    } catch (error: unknown) {
        if (errorMessage(error).includes('No target')) {
            forgetTabActivity(targetId);
            return { closed: true, targetId, alreadyClosed: true };
        }
        throw error;
    } finally {
        await cdp.detach().catch(() => undefined);
    }
}

export async function getPageByTargetId(port = getActivePort(), targetId: string): Promise<Page | null> {
    const { browser } = await connectCdp(port);
    const contexts = browser.contexts();
    for (const context of contexts) {
        for (const page of context.pages()) {
            const session = await context.newCDPSession(page);
            try {
                const targetInfo = await session.send('Target.getTargetInfo');
                if (targetInfoMatches(targetInfo, targetId)) {
                    markTabActive(targetId);
                    return page;
                }
            } finally {
                await session.detach().catch(() => undefined);
            }
        }
    }
    return null;
}

export async function waitForPageByTargetId(port = getActivePort(), targetId: string, timeoutMs = 10_000): Promise<Page> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const page = await getPageByTargetId(port, targetId);
        if (page && !page.isClosed?.()) return page;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`new tab page not found for targetId ${targetId}`);
}

export async function closeBrowser() {
    if (runtimeOwner?.ownership === 'external') {
        disconnectLocalBrowserCache();
        runtimeOwner = null;
        activePort = null;
        verifiedActiveTargetId = null;
        markBrowserStateChanged();
        return;
    }
    await closeOwnedChrome('manual');
}

export function resetBrowserRuntimeForTests(): void {
    cached = null;
    chromeProc = null;
    activePort = null;
    runtimeOwner = null;
    activeCommandCount = 0;
    verifiedActiveTargetId = null;
    browserStateVersion = 0;
    if (idleReaper) {
        clearInterval(idleReaper);
        idleReaper = null;
    }
}
