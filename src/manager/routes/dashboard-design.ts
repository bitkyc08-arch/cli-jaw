import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    createDesignPage,
    exportDesignPage,
    getDesignPage,
    listDesignPages,
    listDesignPageSnapshots,
    localPathsForPage,
    patchDesignPage,
    readDesignPageFile,
    rescanDesignPages,
    restoreDesignPageSnapshot,
    snapshotDesignPage,
    writeDesignPageFile,
} from '../design/store.js';
import { bumpDesignStoreVersion, designStoreVersion, startDesignWatcher } from '../design/watcher.js';

/**
 * `/api/dashboard/design` (186 Phase 3).
 *
 * - GET surfaces are loopback-open (agents list/preview pages).
 * - Mutating surfaces require the Electron desktop identity header, matching
 *   the embedded-browser convention: local agents mutate through the
 *   file-first store (`jaw design` CLI / direct writes), not through HTTP.
 * - Preview serves the artifact as sandboxed HTML with a DocPanel-parity CSP
 *   (no scripts in v1); the panel iframe additionally uses sandbox="".
 * - File writes carry multi-megabyte HTML: the manager's global 64kb parser
 *   skips this prefix (see server.ts) and the router mounts its own bounded
 *   parser.
 */

const DESKTOP_IDENTITY_HEADER = 'x-cli-jaw-electron';
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src data:; script-src 'none'";

function requireDesktopRenderer(req: Request, res: Response, next: NextFunction): void {
    if (req.get(DESKTOP_IDENTITY_HEADER)) {
        next();
        return;
    }
    res.status(403).json({ ok: false, error: 'desktop renderer only (agents use the jaw design CLI / direct file writes)' });
}

function fail(res: Response, error: unknown, code = 400): void {
    const message = (error as Error).message ?? String(error);
    res.status(message.includes('not found') ? 404 : code).json({ ok: false, error: message });
}

function projectQuery(req: Request): string | null | undefined {
    const raw = req.query?.['project'];
    if (typeof raw !== 'string') return undefined;
    return raw.length > 0 ? raw : null;
}

export function createDashboardDesignRouter(): Router {
    const router = Router();
    const jsonParser = express.json({ limit: '8mb' });
    startDesignWatcher();

    router.get('/version', (_req, res) => {
        res.json({ ok: true, version: designStoreVersion() });
    });

    router.get('/pages', (req, res) => {
        try {
            res.json({ ok: true, pages: listDesignPages(projectQuery(req)) });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    router.post('/pages', requireDesktopRenderer, jsonParser, (req, res) => {
        try {
            const body = req.body as { title?: unknown; projectKey?: unknown } | undefined;
            const page = createDesignPage({
                title: typeof body?.title === 'string' ? body.title : '',
                projectKey: typeof body?.projectKey === 'string' ? body.projectKey : null,
            });
            bumpDesignStoreVersion();
            startDesignWatcher();
            res.status(201).json({ ok: true, page });
        } catch (error) {
            fail(res, error);
        }
    });

    router.post('/pages/rescan', (req, res) => {
        try {
            res.json({ ok: true, ...rescanDesignPages(projectQuery(req)) });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    router.get('/pages/:pageId', (req, res) => {
        try {
            res.json({ ok: true, page: getDesignPage(String(req.params['pageId'])) });
        } catch (error) {
            fail(res, error);
        }
    });

    router.patch('/pages/:pageId', requireDesktopRenderer, jsonParser, (req, res) => {
        try {
            const body = req.body as { title?: string; exportTarget?: string | null; baseRevision?: unknown } | undefined;
            if (typeof body?.baseRevision !== 'number') {
                res.status(400).json({ ok: false, error: 'baseRevision required' });
                return;
            }
            const patch: { title?: string; exportTarget?: string | null } = {};
            if (typeof body.title === 'string') patch.title = body.title;
            if (body.exportTarget !== undefined) patch.exportTarget = body.exportTarget;
            const result = patchDesignPage(String(req.params['pageId']), patch, body.baseRevision);
            if (!result.ok && result.conflict) {
                res.status(409).json({ ok: false, conflict: true, currentRevision: result.currentRevision });
                return;
            }
            if (!result.ok) {
                res.status(400).json({ ok: false, error: result.error });
                return;
            }
            res.json({ ok: true, page: result.page });
        } catch (error) {
            fail(res, error);
        }
    });

    router.get('/pages/:pageId/files/{*filePath}', (req, res) => {
        try {
            const rel = Array.isArray(req.params['filePath']) ? (req.params['filePath'] as string[]).join('/') : String(req.params['filePath'] ?? '');
            const file = readDesignPageFile(String(req.params['pageId']), rel);
            res.json({ ok: true, ...file });
        } catch (error) {
            fail(res, error);
        }
    });

    router.put('/pages/:pageId/files/{*filePath}', requireDesktopRenderer, jsonParser, (req, res) => {
        try {
            const rel = Array.isArray(req.params['filePath']) ? (req.params['filePath'] as string[]).join('/') : String(req.params['filePath'] ?? '');
            const body = req.body as { content?: unknown; baseRevision?: unknown } | undefined;
            if (typeof body?.content !== 'string' || typeof body?.baseRevision !== 'number') {
                res.status(400).json({ ok: false, error: 'content and baseRevision required' });
                return;
            }
            const result = writeDesignPageFile(String(req.params['pageId']), rel, body.content, body.baseRevision);
            if (!result.ok && result.conflict) {
                res.status(409).json({ ok: false, conflict: true, currentRevision: result.currentRevision });
                return;
            }
            if (!result.ok) {
                res.status(400).json({ ok: false, error: result.error });
                return;
            }
            bumpDesignStoreVersion();
            res.json({ ok: true, revision: result.revision });
        } catch (error) {
            fail(res, error);
        }
    });

    router.get('/pages/:pageId/local-paths', (req, res) => {
        try {
            res.json({ ok: true, paths: localPathsForPage(String(req.params['pageId'])) });
        } catch (error) {
            fail(res, error);
        }
    });

    router.post('/pages/:pageId/rescan', (req, res) => {
        try {
            getDesignPage(String(req.params['pageId']));
            res.json({ ok: true, scanned: 1 });
        } catch (error) {
            fail(res, error);
        }
    });

    router.post('/pages/:pageId/export', requireDesktopRenderer, jsonParser, (req, res) => {
        try {
            const pageId = String(req.params['pageId']);
            const body = req.body as { target?: unknown; overwrite?: unknown } | undefined;
            // Export overwrites project files: hard gate on a before-snapshot.
            snapshotDesignPage(pageId, 'before');
            const result = exportDesignPage(
                pageId,
                typeof body?.target === 'string' ? body.target : undefined,
                { overwrite: body?.overwrite === true },
            );
            if (!result.ok) {
                res.status(400).json({ ok: false, error: result.error });
                return;
            }
            bumpDesignStoreVersion();
            res.json({ ok: true, exportedTo: result.exportedTo });
        } catch (error) {
            fail(res, error);
        }
    });

    router.post('/pages/:pageId/snapshots', requireDesktopRenderer, jsonParser, (req, res) => {
        try {
            const body = req.body as { label?: unknown } | undefined;
            const label = body?.label === 'before' || body?.label === 'after' || body?.label === 'manual' ? body.label : 'manual';
            const snapshot = snapshotDesignPage(String(req.params['pageId']), label);
            res.status(201).json({ ok: true, snapshot });
        } catch (error) {
            fail(res, error);
        }
    });

    router.get('/pages/:pageId/snapshots', (req, res) => {
        try {
            res.json({ ok: true, snapshots: listDesignPageSnapshots(String(req.params['pageId'])) });
        } catch (error) {
            fail(res, error);
        }
    });

    router.post('/pages/:pageId/snapshots/:snapshotId/restore', requireDesktopRenderer, (req, res) => {
        try {
            const result = restoreDesignPageSnapshot(String(req.params['pageId']), String(req.params['snapshotId']));
            if (!result.ok) {
                res.status(400).json({ ok: false, error: result.error });
                return;
            }
            bumpDesignStoreVersion();
            res.json({ ok: true, recoverySnapshot: result.recoverySnapshot });
        } catch (error) {
            fail(res, error);
        }
    });

    router.get('/catalog', (_req, res) => {
        // v1: a single built-in starter; template packs land with 120+.
        res.json({ ok: true, entries: [{ id: 'blank-html', title: 'Blank HTML page', kind: 'html' }] });
    });

    router.get('/pages/:pageId/preview', (req, res) => {
        try {
            const paths = localPathsForPage(String(req.params['pageId']));
            const html = readFileSync(join(paths.pageDir, 'artifact.html'), 'utf-8');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Content-Security-Policy', PREVIEW_CSP);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.send(html);
        } catch (error) {
            fail(res, error);
        }
    });

    return router;
}
