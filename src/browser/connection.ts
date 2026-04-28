import { JAW_HOME, deriveCdpPort, settings } from '../core/config.js';
import { spawn } from 'child_process';
import { join } from 'path';
import fs from 'node:fs';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { resolveLaunchPolicy, type BrowserStartMode } from './launch-policy.js';

const PROFILE_DIR = join(JAW_HOME, 'browser-profile');
let cached: any = null;   // { browser, cdpUrl }
let chromeProc: any = null;
let activePort: number | null = null;
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
            `${process.env.HOME || ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
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
                console.log(`[browser] CDP already listening on port ${port} — reusing existing instance`);
                activePort = port;
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

    chromeProc = spawn(chrome, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE_DIR}`,
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
    const pages = browser.contexts().flatMap((c: any) => c.pages());
    const matches = [];
    for (const page of pages) {
        const title = await page.title().catch(() => '');
        if (page.url() === wanted.url && title === (wanted.title || '')) matches.push(page);
    }
    if (matches.length !== 1) return { ok: false, reason: matches.length ? 'ambiguous' : 'not-found' };

    await matches[0].bringToFront();
    verifiedActiveTargetId = wanted.id;
    markBrowserStateChanged();
    const active = await getActiveTab(port);
    if (!active.ok || active.tab?.targetId !== wanted.id) return { ok: false, reason: 'unverified' };
    return active;
}

export async function getBrowserStatus(port = getActivePort()) {
    try {
        const tabs = await listTabs(port);
        return { running: true, tabs: tabs.length, cdpUrl: `http://127.0.0.1:${port}` };
    } catch { return { running: false, tabs: 0 }; }
}

export async function getCdpSession(port = getActivePort()) {
    const page = await getActivePage(port);
    if (!page) return null;
    return page.context().newCDPSession(page);
}

export async function closeBrowser() {
    if (cached?.browser) { await cached.browser.close().catch(() => { }); cached = null; }
    if (chromeProc && !chromeProc.killed) { chromeProc.kill('SIGTERM'); chromeProc = null; }
    activePort = null;
    verifiedActiveTargetId = null;
    markBrowserStateChanged();
}
