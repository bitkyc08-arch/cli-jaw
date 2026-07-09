// ─── Root + media static routes ───────────────────────
// Extracted from server.ts in Phase 2 (devlog 260609, 07 §3.1).
// ⚠️ registerStaticRoutes must be called BEFORE app.use(express.static(public))
// — GET / prefers the Vite build (public/dist/index.html) over public/index.html.

import type { Router, RequestHandler } from 'express';
import fs from 'fs';
import { join, basename, resolve, sep } from 'path';
import { UPLOADS_DIR, WIDGETS_DIR } from '../core/config.js';

const SAFE_WIDGET_PARAM_RE = /^[A-Za-z0-9._-]+$/;

function isSafeWidgetParam(value: string): boolean {
    return SAFE_WIDGET_PARAM_RE.test(value) && !value.includes('..');
}

export function registerStaticRoutes(app: Router, requireAuth: RequestHandler, deps: { projectRoot: string }): void {
    // Serve Vite production build (public/dist/index.html) at root when available
    const distIndex = join(deps.projectRoot, 'public', 'dist', 'index.html');
    app.get('/', (_req, res, next) => {
        if (fs.existsSync(distIndex)) {
            res.setHeader('Cache-Control', 'no-store');
            return res.sendFile('dist/index.html', { root: join(deps.projectRoot, 'public') });
        }
        next();
    });

    // Serve uploaded media files (images/videos) for inline rendering
    app.get('/media/:filename', requireAuth, (req, res) => {
        const filename = basename(String(req.params['filename'] || ''));
        if (!filename || filename.includes('..')) { res.status(400).end(); return; }
        const filePath = join(UPLOADS_DIR, filename);
        if (!fs.existsSync(filePath)) { res.status(404).end(); return; }
        res.sendFile(filename, { root: UPLOADS_DIR });
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
