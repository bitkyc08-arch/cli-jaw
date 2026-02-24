import { CLAW_HOME } from '../core/config.js';
import { execSync, spawn } from 'child_process';
import { join } from 'path';
import { chromium } from 'playwright-core';

const DEFAULT_CDP_PORT = 9240;
const PROFILE_DIR = join(CLAW_HOME, 'browser-profile');
let cached = null;   // { browser, cdpUrl }
let chromeProc = null;

function findChrome() {
    const paths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    for (const p of paths) {
        try { execSync(`test -f "${p}"`, { stdio: 'pipe' }); return p; } catch { }
    }
    throw new Error('Chrome not found — install Google Chrome');
}

export async function launchChrome(port = DEFAULT_CDP_PORT) {
    if (chromeProc && !chromeProc.killed) return;
    const chrome = findChrome();
    chromeProc = spawn(chrome, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run', '--no-default-browser-check',
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
    const pages = browser.contexts().flatMap(c => c.pages());
    return pages[pages.length - 1] || null;
}

export async function listTabs(port = DEFAULT_CDP_PORT) {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await resp.json()).filter(t => t.type === 'page');
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
