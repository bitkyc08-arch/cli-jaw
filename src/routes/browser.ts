// ─── Browser API Routes (Phase 7) ─────────────────────
import type { Express, Request, Response } from 'express';
import * as browser from '../browser/index.js';
import { ok } from '../http/response.js';
import { DEBUG_CONSOLE_ONLY_MESSAGE, normalizeBrowserStartMode, type BrowserStartMode } from '../browser/launch-policy.js';

/** Port priority: req param > activePort > settings.browser.cdpPort > deriveCdpPort() */
const cdpPort = (req: Request) => {
    const p = Number(req.query?.port || req.body?.port);
    if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
    return browser.getActivePort();
};

export function resolveBrowserStartOptions(req: Request): {
    port: number;
    mode: BrowserStartMode;
    headless: boolean;
} {
    return {
        port: cdpPort(req),
        mode: normalizeBrowserStartMode(req.body?.mode),
        headless: req.body?.headless === true,
    };
}

export function registerBrowserRoutes(app: Express) {
    app.post('/api/browser/start', async (req: Request, res: Response) => {
        try {
            const start = resolveBrowserStartOptions(req);
            if (start.mode === 'debug') {
                return res.status(400).json({ error: DEBUG_CONSOLE_ONLY_MESSAGE });
            }
            await browser.launchChrome(start.port, { mode: start.mode, headless: start.headless });
            res.json(await browser.getBrowserStatus(start.port));
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/stop', async (_: Request, res: Response) => {
        try { await browser.closeBrowser(); res.json({ ok: true }); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/status', async (req: Request, res: Response) => {
        try { res.json(await browser.getBrowserStatus(cdpPort(req))); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/snapshot', async (req: Request, res: Response) => {
        try {
            res.json({
                nodes: await browser.snapshot(cdpPort(req), {
                    interactive: req.query.interactive === 'true',
                })
            });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/screenshot', async (req: Request, res: Response) => {
        try { res.json(await browser.screenshot(cdpPort(req), req.body)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/act', async (req: Request, res: Response) => {
        try {
            const { kind, ref, text, key, submit, doubleClick, x, y } = req.body;
            let result;
            switch (kind) {
                case 'click': result = await browser.click(cdpPort(req), ref, { doubleClick }); break;
                case 'mouse-click': result = await browser.mouseClick(cdpPort(req), x, y, { doubleClick }); break;
                case 'type': result = await browser.type(cdpPort(req), ref, text, { submit }); break;
                case 'press': result = await browser.press(cdpPort(req), key); break;
                case 'hover': result = await browser.hover(cdpPort(req), ref); break;
                default: return res.status(400).json({ error: `unknown action: ${kind}` });
            }
            res.json(result);
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/vision-click', async (req: Request, res: Response) => {
        try {
            const { target, provider, doubleClick } = req.body;
            if (!target) return res.status(400).json({ error: 'target required' });
            const result = await browser.visionClick(cdpPort(req), target, { provider, doubleClick });
            res.json(result);
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.post('/api/browser/navigate', async (req: Request, res: Response) => {
        try { res.json(await browser.navigate(cdpPort(req), req.body.url)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/tabs', async (req: Request, res: Response) => {
        try { ok(res, { tabs: await browser.listTabs(cdpPort(req)) }); }
        catch (e: unknown) { console.warn('[browser:tabs] failed', { error: (e as Error).message }); ok(res, { tabs: [] }); }
    });

    app.post('/api/browser/evaluate', async (req: Request, res: Response) => {
        try { res.json(await browser.evaluate(cdpPort(req), req.body.expression)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/text', async (req: Request, res: Response) => {
        try { res.json(await browser.getPageText(cdpPort(req), req.query.format as string | undefined)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });
}
