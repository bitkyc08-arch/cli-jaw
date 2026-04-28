// ─── Browser API Routes (Phase 7) ─────────────────────
import type { Express, Request, Response, NextFunction } from 'express';
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

export function registerBrowserRoutes(app: Express, requireAuth: (req: Request, res: Response, next: NextFunction) => void) {
    app.post('/api/browser/start', requireAuth, async (req: Request, res: Response) => {
        try {
            const start = resolveBrowserStartOptions(req);
            if (start.mode === 'debug') {
                return res.status(400).json({ error: DEBUG_CONSOLE_ONLY_MESSAGE });
            }
            await browser.launchChrome(start.port, { mode: start.mode, headless: start.headless });
            res.json(await browser.getBrowserStatus(start.port));
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/stop', requireAuth, async (_: Request, res: Response) => {
        try { await browser.closeBrowser(); res.json({ ok: true }); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/status', async (req: Request, res: Response) => {
        try { res.json(await browser.getBrowserStatus(cdpPort(req))); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/snapshot', requireAuth, async (req: Request, res: Response) => {
        try {
            const result = await browser.snapshot(cdpPort(req), {
                interactive: req.query.interactive === 'true',
                maxNodes: req.query.maxNodes || req.query['max-nodes'],
                json: req.query.json === 'true',
            });
            if (Array.isArray(result)) res.json({ nodes: result });
            else res.json(result);
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/screenshot', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.screenshot(cdpPort(req), req.body)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/act', requireAuth, async (req: Request, res: Response) => {
        try {
            const { kind, ref, fromRef, toRef, text, key, submit, doubleClick, x, y, button, values } = req.body;
            let result;
            switch (kind) {
                case 'click': result = await browser.click(cdpPort(req), ref, { doubleClick, button }); break;
                case 'mouse-click': result = await browser.mouseClick(cdpPort(req), x, y, { doubleClick, button }); break;
                case 'move-mouse': result = await browser.mouseMove(cdpPort(req), x, y); break;
                case 'mouse-down': result = await browser.mouseDown(cdpPort(req), { button }); break;
                case 'mouse-up': result = await browser.mouseUp(cdpPort(req), { button }); break;
                case 'type': result = await browser.type(cdpPort(req), ref, text, { submit }); break;
                case 'press': result = await browser.press(cdpPort(req), key); break;
                case 'hover': result = await browser.hover(cdpPort(req), ref); break;
                case 'scroll': result = await browser.scroll(cdpPort(req), { x, y, ref }); break;
                case 'select': result = await browser.select(cdpPort(req), ref, values || []); break;
                case 'drag': result = await browser.drag(cdpPort(req), fromRef, toRef); break;
                default: return res.status(400).json({ error: `unknown action: ${kind}` });
            }
            res.json(result);
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/vision-click', requireAuth, async (req: Request, res: Response) => {
        try {
            const { target, provider, doubleClick, prepareStable, region, clip, verifyBeforeClick } = req.body;
            if (!target) return res.status(400).json({ error: 'target required' });
            const result = await browser.visionClick(cdpPort(req), target, {
                provider,
                doubleClick,
                prepareStable,
                region,
                clip,
                verifyBeforeClick,
            });
            res.json(result);
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.post('/api/browser/navigate', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.navigate(cdpPort(req), req.body.url)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/reload', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.reload(cdpPort(req))); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/resize', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.resize(cdpPort(req), Number(req.body.width), Number(req.body.height))); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/tabs', requireAuth, async (req: Request, res: Response) => {
        try {
            const tabs = await browser.listTabs(cdpPort(req));
            res.json({ ok: true, tabs, data: { tabs } });
        }
        catch (e: unknown) { console.warn('[browser:tabs] failed', { error: (e as Error).message }); ok(res, { tabs: [] }); }
    });

    app.get('/api/browser/active-tab', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.getActiveTab(cdpPort(req))); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/tab-switch', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.switchTab(cdpPort(req), String(req.body.target || ''))); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/evaluate', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.evaluate(cdpPort(req), req.body.expression)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/text', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.getPageText(cdpPort(req), req.query.format as string | undefined)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/dom', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.getDom(cdpPort(req), req.query)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/console', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.getConsole(cdpPort(req), req.query)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/browser/network', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.getNetwork(cdpPort(req), req.query)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/wait-for-selector', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.waitForSelector(cdpPort(req), req.body.selector, req.body)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/wait-for-text', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.waitForText(cdpPort(req), req.body.text, req.body)); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/web-ai/render', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.webAi.render(req.body)); }
        catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/status', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.webAi.status(cdpPort(req), { vendor: String(req.query.vendor || 'chatgpt') })); }
        catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.post('/api/browser/web-ai/send', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.webAi.send(cdpPort(req), req.body)); }
        catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/poll', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json(await browser.webAi.poll(cdpPort(req), {
                vendor: String(req.query.vendor || 'chatgpt'),
                timeout: String(req.query.timeout || '600'),
                ...(req.query.session ? { session: String(req.query.session) } : {}),
                ...(req.query.allowCopyMarkdownFallback === 'true' ? { allowCopyMarkdownFallback: true } : {}),
            }));
        } catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.post('/api/browser/web-ai/query', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.webAi.query(cdpPort(req), req.body)); }
        catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.post('/api/browser/web-ai/stop', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.webAi.stop(cdpPort(req), req.body)); }
        catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/diagnose', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json(await browser.webAi.diagnose(cdpPort(req), {
                vendor: String(req.query.vendor || 'chatgpt'),
                stage: String(req.query.stage || 'unknown'),
            }));
        } catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });
}

function toWebAiHttpError(e: unknown): { ok: false; error: string; stage: string } {
    const err = e as { message?: string; stage?: string };
    return {
        ok: false,
        error: String(err?.message ?? e),
        stage: String(err?.stage ?? 'unknown'),
    };
}
