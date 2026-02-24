// ─── Browser API Routes (Phase 7) ─────────────────────
import * as browser from '../browser/index.ts';
import { ok } from '../http/response.ts';
import { settings } from '../core/config.ts';

const cdpPort = () => settings.browser?.cdpPort || 9240;

export function registerBrowserRoutes(app) {
    app.post('/api/browser/start', async (req, res) => {
        try {
            await browser.launchChrome(req.body?.port || cdpPort());
            res.json(await browser.getBrowserStatus(cdpPort()));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/browser/stop', async (_, res) => {
        try { await browser.closeBrowser(); res.json({ ok: true }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/browser/status', async (_, res) => {
        try { res.json(await browser.getBrowserStatus(cdpPort())); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/browser/snapshot', async (req, res) => {
        try {
            res.json({
                nodes: await browser.snapshot(cdpPort(), {
                    interactive: req.query.interactive === 'true',
                })
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/browser/screenshot', async (req, res) => {
        try { res.json(await browser.screenshot(cdpPort(), req.body)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/browser/act', async (req, res) => {
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/browser/vision-click', async (req, res) => {
        try {
            const { target, provider, doubleClick } = req.body;
            if (!target) return res.status(400).json({ error: 'target required' });
            const result = await browser.visionClick(cdpPort(), target, { provider, doubleClick });
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/browser/navigate', async (req, res) => {
        try { res.json(await browser.navigate(cdpPort(), req.body.url)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/browser/tabs', async (_, res) => {
        try { ok(res, { tabs: await browser.listTabs(cdpPort()) }); }
        catch (e) { console.warn('[browser:tabs] failed', { error: e.message }); ok(res, { tabs: [] }); }
    });

    app.post('/api/browser/evaluate', async (req, res) => {
        try { res.json(await browser.evaluate(cdpPort(), req.body.expression)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/browser/text', async (req, res) => {
        try { res.json(await browser.getPageText(cdpPort(), req.query.format)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
}
