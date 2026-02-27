// ─── Browser API Routes (Phase 7) ─────────────────────
import type { Express, Request, Response } from 'express';
import * as browser from '../browser/index.js';
import { ok } from '../http/response.js';
import { settings, deriveCdpPort } from '../core/config.js';

const cdpPort = () => settings.browser?.cdpPort || deriveCdpPort();

export function registerBrowserRoutes(app: Express) {
    app.post('/api/browser/start', async (req: Request, res: Response) => {
        try {
            const requestedPort = Number(req.body?.port);
            const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
                ? requestedPort
                : cdpPort();
            await browser.launchChrome(port, { headless: req.body?.headless === true });
            res.json(await browser.getBrowserStatus(port));
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/stop', async (_: Request, res: Response) => {
        try { await browser.closeBrowser(); res.json({ ok: true }); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/status', async (_: Request, res: Response) => {
        try { res.json(await browser.getBrowserStatus(cdpPort())); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/snapshot', async (req: Request, res: Response) => {
        try {
            res.json({
                nodes: await browser.snapshot(cdpPort(), {
                    interactive: req.query.interactive === 'true',
                })
            });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/screenshot', async (req: Request, res: Response) => {
        try { res.json(await browser.screenshot(cdpPort(), req.body)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/act', async (req: Request, res: Response) => {
        try {
            const { kind, ref, text, key, submit, doubleClick, x, y } = req.body;
            let result;
            switch (kind) {
                case 'click': result = await browser.click(cdpPort(), ref, { doubleClick }); break;
                case 'mouse-click': result = await browser.mouseClick(cdpPort(), x, y, { doubleClick }); break;
                case 'type': result = await browser.type(cdpPort(), ref, text, { submit }); break;
                case 'press': result = await browser.press(cdpPort(), key); break;
                case 'hover': result = await browser.hover(cdpPort(), ref); break;
                default: return res.status(400).json({ error: `unknown action: ${kind}` });
            }
            res.json(result);
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/vision-click', async (req: Request, res: Response) => {
        try {
            const { target, provider, doubleClick } = req.body;
            if (!target) return res.status(400).json({ error: 'target required' });
            const result = await browser.visionClick(cdpPort(), target, { provider, doubleClick });
            res.json(result);
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.post('/api/browser/navigate', async (req: Request, res: Response) => {
        try { res.json(await browser.navigate(cdpPort(), req.body.url)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/tabs', async (_: Request, res: Response) => {
        try { ok(res, { tabs: await browser.listTabs(cdpPort()) }); }
        catch (e: unknown) { console.warn('[browser:tabs] failed', { error: (e as Error).message }); ok(res, { tabs: [] }); }
    });

    app.post('/api/browser/evaluate', async (req: Request, res: Response) => {
        try { res.json(await browser.evaluate(cdpPort(), req.body.expression)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/text', async (req: Request, res: Response) => {
        try { res.json(await browser.getPageText(cdpPort(), req.query.format as string | undefined)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });
}
