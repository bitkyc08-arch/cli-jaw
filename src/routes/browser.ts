// ─── Browser API Routes (Phase 7) ─────────────────────
import type { WebAiVendor, WebAiNotificationStatus } from '../browser/web-ai/types.js';
import type { WebAiVendorScope, CapabilityFamily, FrontendObservationStatus } from '../browser/web-ai/capability-registry.js';
import type { Express, Request, Response, NextFunction } from 'express';
import * as browser from '../browser/index.js';
import { cleanupPoolTabs } from '../browser/web-ai/tab-pool.js';
import { ok } from '../http/response.js';
import { DEBUG_CONSOLE_ONLY_MESSAGE, normalizeBrowserStartMode, type BrowserStartMode } from '../browser/launch-policy.js';

/** Port priority: req param > activePort > settings.browser.cdpPort > deriveCdpPort() */
const cdpPort = (req: Request) => {
    const p = Number(req.query?.port || req.body?.port);
    if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
    return browser.getActivePort();
};

const BROWSER_ACTIVITY_PATHS = [
    '/api/browser/snapshot',
    '/api/browser/screenshot',
    '/api/browser/act',
    '/api/browser/vision-click',
    '/api/browser/navigate',
    '/api/browser/reload',
    '/api/browser/resize',
    '/api/browser/tabs',
    '/api/browser/active-tab',
    '/api/browser/tab-switch',
    '/api/browser/evaluate',
    '/api/browser/text',
    '/api/browser/dom',
    '/api/browser/console',
    '/api/browser/network',
    '/api/browser/wait-for-selector',
    '/api/browser/wait-for-text',
    '/api/browser/web-ai/status',
    '/api/browser/web-ai/send',
    '/api/browser/web-ai/poll',
    '/api/browser/web-ai/watch',
    '/api/browser/web-ai/query',
    '/api/browser/web-ai/stop',
    '/api/browser/web-ai/diagnose',
];

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
    app.use(BROWSER_ACTIVITY_PATHS, requireAuth, (_req: Request, res: Response, next: NextFunction) => {
        const endActivity = browser.beginBrowserActivity();
        res.once('finish', endActivity);
        res.once('close', endActivity);
        next();
    });

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

    app.get('/api/browser/doctor', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.getBrowserDiagnostics(cdpPort(req))); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/cleanup-runtimes', requireAuth, async (req: Request, res: Response) => {
        try {
            if (req.body.close === true && req.body.force !== true) {
                res.status(400).json({ error: 'cleanup-runtimes close requires force=true' });
                return;
            }
            res.json(await browser.cleanupBrowserRuntimeOrphans({
                close: req.body.close === true,
                force: req.body.force === true,
                currentRuntime: browser.getBrowserRuntimeStatus(),
            }));
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
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

    app.post('/api/browser/tab-new', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json(await browser.createTab(cdpPort(req), String(req.body.url || 'about:blank'), {
                activate: req.body.activate !== false,
            }));
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/tab-close', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.closeTab(cdpPort(req), String(req.body.targetId || req.body.target || ''))); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/browser/tab-cleanup', requireAuth, async (req: Request, res: Response) => {
        try {
            if (req.body.includeUntracked === true && req.body.force !== true) {
                res.status(400).json({ error: 'tab-cleanup includeUntracked requires force=true' });
                return;
            }
            const leaseResult = await cleanupPoolTabs(cdpPort(req));
            const idleResult = await browser.cleanupIdleTabs(cdpPort(req), {
                idleTimeoutMs: req.body.idleAfter ? browser.parseTabDuration(String(req.body.idleAfter)) : undefined,
                maxTabs: req.body.maxTabs ? Number(req.body.maxTabs) : undefined,
                includeUntracked: req.body.includeUntracked === true,
                provider: req.body.provider ? String(req.body.provider) : undefined,
                keepProviderTabs: req.body.keepProviderTabs ? Number(req.body.keepProviderTabs) : undefined,
            });
            res.json({
                ...idleResult,
                closed: idleResult.closed + (leaseResult.closed || 0),
                leaseClosed: leaseResult.closed || 0,
                leaseClosedTabs: leaseResult.closedTabs || [],
            });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
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

    app.post('/api/browser/web-ai/context-dry-run', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.webAi.contextDryRun(req.body)); }
        catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.post('/api/browser/web-ai/context-render', requireAuth, async (req: Request, res: Response) => {
        try { res.json(await browser.webAi.contextRender(req.body)); }
        catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/status', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json(await browser.webAi.status(cdpPort(req), {
                vendor: String(req.query.vendor || 'chatgpt'),
                ...(req.query.probe ? { probe: String(req.query.probe) } : {}),
            }));
        } catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
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
                ...(req.query.requireSourceAudit === 'true' ? { requireSourceAudit: true } : {}),
                ...(req.query.sourceAuditRatio ? { sourceAuditRatio: String(req.query.sourceAuditRatio) } : {}),
                ...(req.query.sourceAuditScope ? { sourceAuditScope: String(req.query.sourceAuditScope) } : {}),
                ...(req.query.sourceAuditDate ? { sourceAuditDate: String(req.query.sourceAuditDate) } : {}),
            }));
        } catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/watch', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json(await browser.webAi.watch(cdpPort(req), {
                vendor: String(req.query.vendor || 'chatgpt'),
                timeout: String(req.query.timeout || '600'),
                ...(req.query.session ? { session: String(req.query.session) } : {}),
                ...(req.query.url ? { url: String(req.query.url) } : {}),
                ...(req.query.notify !== undefined ? { notify: String(req.query.notify) !== 'false' } : {}),
                ...(req.query.pollIntervalSeconds ? { pollIntervalSeconds: String(req.query.pollIntervalSeconds) } : {}),
                ...(req.query.allowCopyMarkdownFallback === 'true' ? { allowCopyMarkdownFallback: true } : {}),
                ...(req.query.requireSourceAudit === 'true' ? { requireSourceAudit: true } : {}),
                ...(req.query.sourceAuditRatio ? { sourceAuditRatio: String(req.query.sourceAuditRatio) } : {}),
                ...(req.query.sourceAuditScope ? { sourceAuditScope: String(req.query.sourceAuditScope) } : {}),
                ...(req.query.sourceAuditDate ? { sourceAuditDate: String(req.query.sourceAuditDate) } : {}),
            }));
        } catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/watchers', requireAuth, async (_req: Request, res: Response) => {
        try { res.json(browser.webAi.watchers()); }
        catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/sessions', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json(await browser.webAi.sessions({
                ...(req.query.vendor ? { vendor: String(req.query.vendor) } : {}),
                ...(req.query.status ? { status: String(req.query.status) } : {}),
            }));
        } catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.post('/api/browser/web-ai/sessions/prune', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json(await browser.webAi.sessionsPrune({
                ...(req.body?.olderThanMs !== undefined ? { olderThanMs: req.body.olderThanMs } : {}),
                ...(req.body?.before ? { before: String(req.body.before) } : {}),
                ...(req.body?.status ? { status: String(req.body.status) } : {}),
            }));
        } catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/notifications', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                vendor: String(req.query.vendor || 'chatgpt'),
                status: 'ready',
                notifications: browser.webAi.listNotifications({
                    ...(req.query.vendor ? { vendor: String(req.query.vendor) as WebAiVendor } : {}),
                    ...(req.query.status ? { status: String(req.query.status) as WebAiNotificationStatus } : {}),
                    ...(req.query.session ? { sessionId: String(req.query.session) } : {}),
                }),
                warnings: [],
            });
        } catch (e: unknown) { res.status(500).json(toWebAiHttpError(e)); }
    });

    app.get('/api/browser/web-ai/capabilities', requireAuth, async (req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                vendor: String(req.query.vendor || 'chatgpt'),
                status: 'ready',
                capabilities: browser.webAi.listCapabilitySchemas({
                    ...(req.query.vendor ? { vendor: String(req.query.vendor) as WebAiVendorScope } : {}),
                    ...(req.query.family ? { family: String(req.query.family) as CapabilityFamily } : {}),
                    ...(req.query.frontendStatus ? { frontendStatus: String(req.query.frontendStatus) as FrontendObservationStatus } : {}),
                }),
                warnings: [],
            });
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

function toWebAiHttpError(e: unknown): { ok: false; error: string; stage: string; errorCode?: string; retryHint?: string; vendor?: string; mutationAllowed?: boolean; selectorsTried?: string[]; evidence?: unknown } {
    if (isWebAiErrorLike(e)) {
        const json = (e as { toJSON?: () => unknown }).toJSON?.() as Record<string, unknown> | undefined;
        if (json && typeof json === 'object') {
            return {
                ok: false,
                error: String(json.message ?? ''),
                stage: String(json.stage ?? 'unknown'),
                errorCode: json.errorCode as string | undefined,
                retryHint: json.retryHint as string | undefined,
                vendor: json.vendor as string | undefined,
                mutationAllowed: json.mutationAllowed as boolean | undefined,
                selectorsTried: json.selectorsTried as string[] | undefined,
                evidence: json.evidence,
            };
        }
    }
    const err = e as { message?: string; stage?: string };
    return {
        ok: false,
        error: String(err?.message ?? e),
        stage: String(err?.stage ?? 'unknown'),
    };
}

function isWebAiErrorLike(e: unknown): boolean {
    return Boolean(e && typeof e === 'object' && (e as { name?: string }).name === 'WebAiError' && typeof (e as { toJSON?: unknown }).toJSON === 'function');
}
