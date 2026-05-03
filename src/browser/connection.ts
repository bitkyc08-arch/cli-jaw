import { JAW_HOME, deriveCdpPort, settings } from '../core/config.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'path';
import fs from 'node:fs';
import net from 'node:net';
import { chromium, type Browser } from 'playwright-core';
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

const PROFILE_DIR = join(JAW_HOME, 'browser-profile');
type BrowserConnectionCache = { browser: Browser; cdpUrl: string };

let cached: BrowserConnectionCache | null = null;
let chromeProc: ChildProcess | null = null;
let activePort: number | null = null;
let runtimeOwner: BrowserRuntimeOwner | null = null;
let activeCommandCount = 0;
let idleReaper: ReturnType<typeof setInterval> | null = null;
let verifiedActiveTargetId: string | null = null;
let browserStateVersion = 0;

export interface BrowserTabInfo {
    tabId: string;
    targetId: string;
    index: number;
    title: string;
    url: string;
    type: string;
    active: boolean;
    attached: boolean;
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

export function markBrowserStateChanged() {
    browserStateVersion++;
}

export function getBrowserStateVersion() {
    return browserStateVersion;
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

    if (chromeProc && !chromeProc.killed) return;

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
        runtimeOwner = createJawOwnedBrowserRuntime({
            port,
            pid: chromeProc.pid ?? null,
            userDataDir: PROFILE_DIR,
            headless,
        });
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
    const pages = browser.contexts().flatMap((c: any) => c.pages());
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

export async function getCdpSession(port = getActivePort()) {
    const page = await getActivePage(port);
    if (!page) return null;
    return page.context().newCDPSession(page);
}

export async function createTab(port = getActivePort(), url = 'about:blank', opts: { activate?: boolean } = {}): Promise<{ targetId: string; url: string; title: string; activated: boolean }> {
    const cdp = await getCdpSession(port);
    if (!cdp) throw new Error('No CDP session available for tab creation');
    try {
        const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: false, background: !opts.activate });
        await new Promise(r => setTimeout(r, 100));
        const tabs = await readCdpPageTargets(port);
        const tab = tabs.find(t => t.id === targetId);
        return { targetId, url: tab?.url || url, title: tab?.title || 'New Tab', activated: opts.activate !== false };
    } finally {
        await cdp.detach().catch(() => undefined);
    }
}

export async function closeTab(port = getActivePort(), targetId: string): Promise<{ closed: boolean; targetId: string; alreadyClosed?: boolean }> {
    const cdp = await getCdpSession(port);
    if (!cdp) throw new Error('No CDP session available for tab close');
    try {
        await cdp.send('Target.closeTarget', { targetId });
        return { closed: true, targetId };
    } catch (error: any) {
        if (error.message?.includes('No target')) return { closed: true, targetId, alreadyClosed: true };
        throw error;
    } finally {
        await cdp.detach().catch(() => undefined);
    }
}

export async function getPageByTargetId(port = getActivePort(), targetId: string): Promise<any | null> {
    const { browser } = await connectCdp(port);
    const contexts = browser.contexts();
    for (const context of contexts) {
        for (const page of context.pages()) {
            const session = await context.newCDPSession(page);
            try {
                const { targetInfo } = await session.send('Target.getTargetInfo');
                if (targetInfo.targetId === targetId) return page;
            } finally {
                await session.detach().catch(() => undefined);
            }
        }
    }
    return null;
}

export async function waitForPageByTargetId(port = getActivePort(), targetId: string, timeoutMs = 10_000): Promise<any> {
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
