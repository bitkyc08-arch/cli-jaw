// 048 Gate D1 — Electron repackaged real-device smoke: identify/envelope,
// clipboard round-trip, reload, against the freshly packaged app launched
// with a remote debugging port (CDP via playwright-core).
// Usage: npx tsx tests/smoke/dashboard2-electron-smoke.mts [--app <path to .app>]
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CDP_PORT = 9339;

function findApp(): string {
    const distDir = join(ROOT, 'electron/dist/mac-arm64');
    if (existsSync(distDir)) {
        const app = readdirSync(distDir).find(name => name.endsWith('.app'));
        if (app) return join(distDir, app);
    }
    const alt = join(ROOT, 'electron/dist');
    for (const sub of existsSync(alt) ? readdirSync(alt) : []) {
        const dir = join(alt, sub);
        if (sub.endsWith('.app')) return dir;
        if (existsSync(dir) && !sub.includes('.')) {
            const app = readdirSync(dir).find(name => name.endsWith('.app'));
            if (app) return join(dir, app);
        }
    }
    throw new Error('packaged .app not found under electron/dist');
}

async function main(): Promise<void> {
    const appPath = findApp();
    const binDir = join(appPath, 'Contents/MacOS');
    const binary = join(binDir, readdirSync(binDir)[0]);
    console.log(`[electron-smoke] launching ${binary}`);
    const child = spawn(binary, [`--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore' });
    const cleanup = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    process.on('exit', cleanup);

    let browser = null as Awaited<ReturnType<typeof chromium.connectOverCDP>> | null;
    for (let i = 0; i < 45; i++) {
        try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); break; }
        catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    if (!browser) throw new Error('CDP connect failed');
    // find the dashboard2 window
    let page = null as import('playwright-core').Page | null;
    for (let i = 0; i < 30 && !page; i++) {
        for (const context of browser.contexts()) {
            for (const candidate of context.pages()) {
                const url = candidate.url();
                if (url.includes('dashboard2') || url.includes('dist')) { page = candidate; break; }
            }
        }
        if (!page) await new Promise(r => setTimeout(r, 1000));
    }
    if (!page) {
        const context = browser.contexts()[0];
        page = context?.pages()[0] ?? null;
    }
    if (!page) throw new Error('no page found in packaged app');
    console.log(`[electron-smoke] page: ${page.url()}`);

    // identify/envelope: desktop bridge v1 surface
    const identify = await page.evaluate(async () => {
        const bridge = (window as unknown as Record<string, any>).jawDesktop
            ?? (window as unknown as Record<string, any>).desktopBridge;
        if (!bridge) return { present: false };
        try {
            const result = typeof bridge.identify === 'function' ? await bridge.identify() : bridge.identity ?? null;
            return { present: true, identify: result };
        } catch (error) { return { present: true, error: String(error) }; }
    });

    // clipboard round-trip through the real OS clipboard
    const marker = `jaw-048-smoke-${Date.now()}`;
    const clipboard = await page.evaluate(async (text) => {
        const bridge = (window as unknown as Record<string, any>).jawDesktop
            ?? (window as unknown as Record<string, any>).desktopBridge;
        try {
            if (bridge?.clipboard?.writeText) {
                await bridge.clipboard.writeText(text);
                const read = await bridge.clipboard.readText();
                return { path: 'bridge', roundTrip: read === text };
            }
            await navigator.clipboard.writeText(text);
            const read = await navigator.clipboard.readText();
            return { path: 'navigator', roundTrip: read === text };
        } catch (error) { return { path: 'none', roundTrip: false, error: String(error) }; }
    }, marker);

    // reload keeps the dashboard2 URL
    const urlBefore = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const urlAfter = page.url();
    const reloadOk = urlAfter === urlBefore;

    const evidence = { appPath, url: urlBefore, identify, clipboard, reloadOk, at: new Date().toISOString() };
    console.log('[electron-smoke]', JSON.stringify(evidence));
    writeFileSync(join(ROOT, 'devlog/_plan/260711_manager_redesign_feature_migration/refs/048-gateD1-electron-evidence.json'),
        JSON.stringify(evidence, null, 2));
    cleanup();
    process.exit(clipboard.roundTrip && reloadOk ? 0 : 1);
}

main().catch(error => { console.error('[electron-smoke] fatal', error); process.exit(1); });
