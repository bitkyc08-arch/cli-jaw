// ─── Root + media static routes ───────────────────────
// Extracted from server.ts in Phase 2.
// ⚠️ registerStaticRoutes must be called BEFORE app.use(express.static(public))
// GET / prefers the Vite build (public/dist/index.html) over public/index.html.

import type { Router, RequestHandler } from 'express';
import fs from 'fs';
import { join, basename, dirname, extname, isAbsolute, resolve, sep } from 'path';
import { settings, UPLOADS_DIR, WIDGETS_DIR } from '../core/config.js';
import { assertSendFilePath } from '../security/path-guards.js';

const SAFE_WIDGET_PARAM_RE = /^[A-Za-z0-9._-]+$/;
const INLINE_MEDIA_CONTENT_TYPES = new Map<string, string>([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.mp4', 'video/mp4'],
    ['.webm', 'video/webm'],
    ['.mov', 'video/quicktime'],
    ['.ogg', 'video/ogg'],
]);
const indexRoutes = new WeakMap<Router, { serveIndex: RequestHandler; publicRoot: string }>();

function createIndexHandler(projectRoot: string): RequestHandler {
    const publicRoot = join(projectRoot, 'public');
    const distIndex = join(publicRoot, 'dist', 'index.html');
    return (_req, res, next) => {
        if (fs.existsSync(distIndex)) {
            res.setHeader('Cache-Control', 'no-store');
            return res.sendFile('dist/index.html', { root: publicRoot });
        }
        next();
    };
}

function isSafeWidgetParam(value: string): boolean {
    return SAFE_WIDGET_PARAM_RE.test(value) && !value.includes('..');
}

export function registerStaticRoutes(app: Router, requireAuth: RequestHandler, deps: { projectRoot: string }): void {
    // Serve Vite production build (public/dist/index.html) at root when available
    const serveIndex = createIndexHandler(deps.projectRoot);
    indexRoutes.set(app, { serveIndex, publicRoot: join(deps.projectRoot, 'public') });
    app.get('/', serveIndex);

    // Serve uploaded media files (images/videos) for inline rendering
    app.get('/media/:filename', requireAuth, (req, res) => {
        const filename = basename(String(req.params['filename'] || ''));
        if (!filename || filename.includes('..')) { res.status(400).end(); return; }
        const filePath = join(UPLOADS_DIR, filename);
        if (!fs.existsSync(filePath)) { res.status(404).end(); return; }
        res.sendFile(filename, { root: UPLOADS_DIR });
    });

    // Serve guarded local image/video files outside UPLOADS_DIR.
    app.get('/api/image', requireAuth, (req, res, next) => {
        const rawPath = req.query['path'];
        if (
            typeof rawPath !== 'string'
            || rawPath.length === 0
            || rawPath.includes('\0')
            || !isAbsolute(rawPath)
        ) {
            res.status(400).end();
            return;
        }

        let safePath: string;
        try {
            safePath = assertSendFilePath(
                rawPath,
                settings['workingDir'] || undefined,
                settings['projectDirs'] || null,
            );
        } catch (error: unknown) {
            if (error instanceof Error && error.message === 'path_not_resolvable') {
                res.status(404).end();
                return;
            }
            next(error);
            return;
        }

        const contentType = INLINE_MEDIA_CONTENT_TYPES.get(extname(safePath).toLowerCase());
        if (!contentType) {
            res.status(400).end();
            return;
        }

        try {
            if (!fs.statSync(safePath).isFile()) {
                res.status(404).end();
                return;
            }
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                res.status(404).end();
                return;
            }
            next(error);
            return;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(basename(safePath), { root: dirname(safePath) });
    });

    // Serve widget files as inert text. Accepting ".html" in widgetId is normalized
    // by stripping it before appending the server-owned extension.
    app.get('/api/widgets/:chatId/:widgetId', requireAuth, (req, res) => {
        const chatId = String(req.params['chatId'] || '');
        const widgetId = String(req.params['widgetId'] || '');
        if (!isSafeWidgetParam(chatId) || !isSafeWidgetParam(widgetId)) {
            res.status(400).end();
            return;
        }

        const normalizedWidgetId = widgetId.replace(/\.html$/i, '');
        const widgetsRoot = resolve(WIDGETS_DIR);
        const filePath = resolve(WIDGETS_DIR, chatId, `${normalizedWidgetId}.html`);
        if (!filePath.startsWith(widgetsRoot + sep)) {
            res.status(400).end();
            return;
        }
        if (!fs.existsSync(filePath)) {
            res.status(404).end();
            return;
        }

        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                res.status(err && 'code' in err && err.code === 'ENOENT' ? 404 : 500).end();
                return;
            }
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).send(data);
        });
    });
}

export function registerSessionPageRoute(app: Router): void {
    const indexRoute = indexRoutes.get(app);
    if (!indexRoute) throw new Error('registerStaticRoutes must run before registerSessionPageRoute');
    app.get(/^\/\d+\/?$/, (req, res, next) => {
        indexRoute.serveIndex(req, res, () => {
            const sourceIndex = join(indexRoute.publicRoot, 'index.html');
            if (fs.existsSync(sourceIndex)) {
                res.sendFile('index.html', { root: indexRoute.publicRoot });
                return;
            }
            next();
        });
    });
}
