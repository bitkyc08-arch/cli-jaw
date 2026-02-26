import { JAW_HOME } from '../core/config.js';
import { spawn } from 'child_process';
import { join } from 'path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const DEFAULT_CDP_PORT = 9240;
const PROFILE_DIR = join(JAW_HOME, 'browser-profile');
let cached: any = null;   // { browser, cdpUrl }
let chromeProc: any = null;

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

export async function launchChrome(port = DEFAULT_CDP_PORT) {
    if (chromeProc && !chromeProc.killed) return;
    const chrome = findChrome();
    const noSandbox = process.env.CHROME_NO_SANDBOX === '1';
    chromeProc = spawn(chrome, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-dev-shm-usage',
        ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    ], { detached: true, stdio: 'ignore' });
    chromeProc.unref();
    await new Promise(r => setTimeout(r, 2000));
}

export async function connectCdp(port = DEFAULT_CDP_PORT) {
    const cdpUrl = `http://127.0.0.1:${port}`;
    if (cached?.cdpUrl === cdpUrl && cached.browser.isConnected()) return cached;
    const browser = await chromium.connectOverCDP(cdpUrl);
    cached = { browser, cdpUrl };
    browser.on('disconnected', () => { cached = null; });
    return cached;
}

export async function getActivePage(port = DEFAULT_CDP_PORT) {
    const { browser } = await connectCdp(port);
    const pages = browser.contexts().flatMap((c: any) => c.pages());
    return pages[pages.length - 1] || null;
}

export async function listTabs(port = DEFAULT_CDP_PORT) {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
    return ((await resp.json()) as any[]).filter((t: any) => t.type === 'page');
}

export async function getBrowserStatus(port = DEFAULT_CDP_PORT) {
    try {
        const tabs = await listTabs(port);
        return { running: true, tabs: tabs.length, cdpUrl: `http://127.0.0.1:${port}` };
    } catch { return { running: false, tabs: 0 }; }
}

export async function getCdpSession(port = DEFAULT_CDP_PORT) {
    const page = await getActivePage(port);
    if (!page) return null;
    return page.context().newCDPSession(page);
}

export async function closeBrowser() {
    if (cached?.browser) { await cached.browser.close().catch(() => { }); cached = null; }
    if (chromeProc && !chromeProc.killed) { chromeProc.kill('SIGTERM'); chromeProc = null; }
}
