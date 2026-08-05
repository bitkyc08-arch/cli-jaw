import express, {
    type ErrorRequestHandler,
    type Request,
    type RequestHandler,
    type Response,
} from 'express';
import { requireNotesAuth, notesCorsPreflight, getAuthStatus } from './auth.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import type { DashboardPutNoteRequest } from '../types.js';
import { NOTE_ASSET_JSON_LIMIT, NotesAssetStore } from './assets.js';
import { type NotePathError, notePathError } from '../../notes/path-guards.js';
import { saveRemoteNoteAsset } from './remote-assets.js';
import { NotesStore } from './store.js';
import { NotesTrash } from './trash.js';
import type { DashboardTrashNoteKind } from '../types.js';
import { createNotesWatcher, type NotesWatcher } from './watcher.js';
import { NoteGitManager } from './git.js';
import { PluginManager } from './plugins.js';
import { NotesVaultIndex } from './vault-index.js';
import { detectNotesCapabilities } from './capabilities.js';
import { searchNotes } from '../../notes/search.js';

export type DashboardNotesRouterOptions = {
    managerPort: number;
    settingsPath?: string;
    store?: NotesStore;
    assetStore?: NotesAssetStore;
    trash?: NotesTrash;
    watcher?: NotesWatcher;
    wsTokenIssuer?: { issueToken: () => string };
};

type RouteBody = Record<string, unknown>;

function isNotePathError(error: unknown): error is NotePathError {
    return error instanceof Error
        && typeof (error as Partial<NotePathError>).statusCode === 'number'
        && typeof (error as Partial<NotePathError>).code === 'string';
}

function sendError(res: Response, error: unknown): void {
    if (isNotePathError(error)) {
        res.status(error.statusCode).json({
            ok: false,
            code: error.code,
            error: error.message,
        });
        return;
    }
    res.status(500).json({
        ok: false,
        code: 'note_internal_error',
        error: error instanceof Error ? error.message : 'Unknown notes error',
    });
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return (req, res) => {
        void handler(req, res).catch(error => sendError(res, error));
    };
}

function bodyObject(req: Request): RouteBody {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw notePathError(400, 'invalid_json', 'request body must be a JSON object');
    }
    return req.body as RouteBody;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function requireString(value: unknown, code: string, message: string): string {
    if (typeof value !== 'string') throw notePathError(400, code, message);
    return value;
}

function optionalTrashKind(value: unknown): DashboardTrashNoteKind {
    if (value === undefined || value === null || value === '') return 'file';
    if (value === 'file' || value === 'folder') return value;
    throw notePathError(400, 'invalid_note_trash_kind', 'trash kind must be file or folder');
}

export function createNotesJsonErrorHandler(): ErrorRequestHandler {
    return (error, _req, res, next) => {
        if (!error) {
            next();
            return;
        }
        const typed = error as { type?: string; body?: unknown; message?: string };
        if (typed.type === 'entity.too.large') {
            res.status(413).json({
                ok: false,
                code: 'note_payload_too_large',
                error: 'Note payload exceeds the maximum supported size.',
            });
            return;
        }
        if (error instanceof SyntaxError && 'body' in typed) {
            res.status(400).json({
                ok: false,
                code: 'invalid_json',
                error: 'Request body must be valid JSON.',
            });
            return;
        }
        next(error);
    };
}

export function createDashboardNotesRouter(options: DashboardNotesRouterOptions): express.Router {
    const router = express.Router();
    const store = options.store || new NotesStore();
    const assetStore = options.assetStore || new NotesAssetStore({ notesRoot: store.rootPath() });
    const trash = options.trash || new NotesTrash();
    const watcher = options.watcher || createNotesWatcher(store.rootPath());
    const vaultIndex = new NotesVaultIndex({
        root: store.rootPath(),
        watcherVersion: watcher.version,
    });

    const settingsPath = options.settingsPath || '';
    router.use(notesCorsPreflight({ managerPort: options.managerPort, settingsPath }));
    router.use(requireNotesAuth({ managerPort: options.managerPort, settingsPath }));

    router.get('/auth/status', (_req, res) => {
        res.json(getAuthStatus(settingsPath));
    });

    router.post('/ws-token', (_req, res) => {
        if (!options.wsTokenIssuer) {
            res.status(501).json({ ok: false, error: 'WebSocket not available' });
            return;
        }
        res.json({ token: options.wsTokenIssuer.issueToken() });
    });

    const gitManager = new NoteGitManager(store.rootPath());

    router.get('/history/status', asyncRoute(async (_req, res) => {
        const available = await gitManager.isAvailable();
        res.json({ available, initialized: gitManager.isInitialized() });
    }));

    router.post('/history/init', asyncRoute(async (_req, res) => {
        await gitManager.init();
        res.json({ ok: true, initialized: gitManager.isInitialized() });
    }));

    router.get('/history', asyncRoute(async (req, res) => {
        const path = requireString(req.query["path"], 'invalid_note_path', 'path query is required');
        const limit = typeof req.query["limit"] === 'string' ? Number(req.query["limit"]) : 50;
        res.json(await gitManager.log(path, limit));
    }));

    router.get('/history/show', asyncRoute(async (req, res) => {
        const hash = requireString(req.query["hash"], 'invalid_git_hash', 'hash query is required');
        const path = requireString(req.query["path"], 'invalid_note_path', 'path query is required');
        const content = await gitManager.show(hash, path);
        res.json({ hash, path, content });
    }));

    router.get('/history/diff', asyncRoute(async (req, res) => {
        const from = requireString(req.query["from"], 'invalid_git_hash', 'from query is required');
        const to = requireString(req.query["to"], 'invalid_git_hash', 'to query is required');
        const path = requireString(req.query["path"], 'invalid_note_path', 'path query is required');
        const diff = await gitManager.diff(from, to, path);
        res.json({ from, to, path, diff });
    }));

    router.post('/history/flush', asyncRoute(async (_req, res) => {
        await gitManager.flush();
        res.json({ ok: true });
    }));

    const pluginManager = new PluginManager(store.rootPath());

    router.get('/plugins', asyncRoute(async (_req, res) => {
        res.json(await pluginManager.listPlugins());
    }));

    router.get('/plugins/:id/asset/*assetPath', asyncRoute(async (req, res) => {
        const id = String(req.params['id'] ?? '');
        const rawAssetPath = req.params['assetPath'];
        const assetPath = Array.isArray(rawAssetPath) ? rawAssetPath.join('/') : String(rawAssetPath ?? '');
        const result = await pluginManager.getPluginAsset(id, assetPath);
        if (!result) { res.status(404).json({ error: 'Plugin asset not found' }); return; }
        res.type(result.mime).send(result.content);
    }));

    router.get('/version', (_req, res) => {
        res.json({ version: watcher.version() });
    });

    router.post('/asset', express.json({ limit: NOTE_ASSET_JSON_LIMIT }), asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        res.status(201).json(await assetStore.saveAsset({
            notePath: requireString(body["notePath"], 'invalid_note_path', 'notePath is required'),
            mime: requireString(body["mime"], 'note_asset_unsupported_type', 'mime is required'),
            dataBase64: requireString(body["dataBase64"], 'note_asset_invalid_base64', 'dataBase64 is required'),
        }));
    }));

    router.post('/asset/remote', express.json({ limit: '32kb' }), asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        res.status(201).json(await saveRemoteNoteAsset(assetStore, {
            notePath: requireString(body["notePath"], 'invalid_note_path', 'notePath is required'),
            url: requireString(body["url"], 'note_asset_remote_invalid_url', 'url is required'),
        }));
    }));

    router.get('/asset', asyncRoute(async (req, res) => {
        const path = requireString(req.query["path"], 'invalid_note_asset_path', 'path query is required');
        const asset = await assetStore.resolveAsset(path);
        res.setHeader('Content-Type', asset.mime);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(asset.absolutePath, { dotfiles: 'allow' }, error => {
            if (error && !res.headersSent) sendError(res, error);
        });
    }));

    router.use(createNotesJsonErrorHandler());
    router.use(express.json({ limit: '1100kb' }));
    router.use(createNotesJsonErrorHandler());

    router.get('/info', (_req, res) => {
        res.json({ root: store.rootPath() });
    });

    router.get('/tree', asyncRoute(async (_req, res) => {
        res.json(await store.listTree());
    }));

    router.get('/templates', asyncRoute(async (_req, res) => {
        res.json(await store.listTemplates());
    }));

    router.get('/template', asyncRoute(async (req, res) => {
        const name = requireString(req.query["name"], 'invalid_template_name', 'name query is required');
        res.json(await store.readTemplate(name));
    }));

    router.get('/snippets', asyncRoute(async (_req, res) => {
        res.json(await store.listSnippets());
    }));

    router.get('/snippets/file', asyncRoute(async (req, res) => {
        const name = requireString(req.query["name"], 'invalid_snippet_name', 'name query is required');
        const css = await store.readSnippet(name);
        res.type('text/css').send(css);
    }));

    router.put('/snippets/toggle', asyncRoute(async (req, res) => {
        const name = requireString(req.body?.name, 'invalid_snippet_name', 'name is required');
        const enabled = req.body?.enabled === true;
        await store.toggleSnippet(name, enabled);
        res.json({ ok: true });
    }));

    router.put('/theme', asyncRoute(async (req, res) => {
        const theme = req.body?.theme ?? null;
        await store.setActiveTheme(typeof theme === 'string' ? theme : null);
        res.json({ ok: true });
    }));

    router.put('/plugins/:id/toggle', asyncRoute(async (req, res) => {
        const id = String(req.params['id'] ?? '');
        const enabled = req.body?.enabled === true;
        await pluginManager.togglePlugin(id, enabled);
        res.json({ ok: true });
    }));

    router.get('/search', asyncRoute(async (req, res) => {
        const q = requireString(req.query["q"], 'invalid_note_search_query', 'q query param is required');
        const limit = typeof req.query["limit"] === 'string' ? Number(req.query["limit"]) : undefined;
        const regex = req.query["regex"] === 'true';
        res.json(await searchNotes(store.rootPath(), q, stripUndefined({ limit, regex })));
    }));

    router.get('/index', asyncRoute(async (_req, res) => {
        res.json(await vaultIndex.snapshot());
    }));

    router.get('/capabilities', asyncRoute(async (_req, res) => {
        res.json(await detectNotesCapabilities());
    }));

    router.get('/file', asyncRoute(async (req, res) => {
        const path = requireString(req.query["path"], 'invalid_note_path', 'path query is required');
        res.json(await store.readFile(path));
    }));

    router.post('/file', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const path = requireString(body["path"], 'invalid_note_path', 'path is required');
        res.status(201).json(await store.createFile(path, optionalString(body["content"]) || ''));
    }));

    router.put('/file', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const request: DashboardPutNoteRequest = stripUndefined({
            path: requireString(body["path"], 'invalid_note_path', 'path is required'),
            content: requireString(body["content"], 'invalid_note_content', 'content is required'),
            baseRevision: optionalString(body["baseRevision"]),
        });
        const result = await store.writeFile(request);
        if (gitManager.isInitialized()) gitManager.scheduleAutoCommit(request.path);
        res.json(result);
    }));

    router.post('/folder', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const path = requireString(body["path"], 'invalid_note_folder_path', 'path is required');
        res.status(201).json(await store.createFolder(path));
    }));

    router.post('/rename', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const from = requireString(body["from"], 'invalid_note_path', 'from is required');
        const to = requireString(body["to"], 'invalid_note_path', 'to is required');
        res.json(await store.rename(from, to));
    }));

    router.post('/trash', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const path = requireString(body["path"], 'invalid_note_path', 'path is required');
        const kind = optionalTrashKind(body["kind"]);
        res.json(await trash.trashPath(store.rootPath(), path, kind));
    }));

    return router;
}
