import express, {
    type ErrorRequestHandler,
    type NextFunction,
    type Request,
    type RequestHandler,
    type Response,
} from 'express';
import {
    isAllowedOriginHeader,
    isExpectedHostHeader,
} from '../security.js';
import type { DashboardPutNoteRequest } from '../types.js';
import { NOTE_ASSET_JSON_LIMIT, NotesAssetStore } from './assets.js';
import { type NotePathError, notePathError } from './path-guards.js';
import { NotesStore } from './store.js';
import { NotesTrash } from './trash.js';
import type { DashboardTrashNoteKind } from '../types.js';

export type DashboardNotesRouterOptions = {
    managerPort: number;
    store?: NotesStore;
    assetStore?: NotesAssetStore;
    trash?: NotesTrash;
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

function requireManagerOrigin(managerPort: number): RequestHandler {
    const allowedOrigins = [
        `http://127.0.0.1:${managerPort}`,
        `http://localhost:${managerPort}`,
    ];
    return (req, res, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            next();
            return;
        }
        const validHost = isExpectedHostHeader(req.headers.host, {
            host: '127.0.0.1',
            port: managerPort,
            allowLocalhostAlias: true,
        });
        const validOrigin = isAllowedOriginHeader(req.headers.origin, {
            allowedOrigins,
            allowMissing: true,
        });
        if (!validHost || !validOrigin) {
            res.status(403).json({
                ok: false,
                code: 'notes_origin_forbidden',
                error: 'Notes mutation must originate from the manager dashboard.',
            });
            return;
        }
        next();
    };
}

export function createDashboardNotesRouter(options: DashboardNotesRouterOptions): express.Router {
    const router = express.Router();
    const store = options.store || new NotesStore();
    const assetStore = options.assetStore || new NotesAssetStore({ notesRoot: store.rootPath() });
    const trash = options.trash || new NotesTrash();

    router.use(requireManagerOrigin(options.managerPort));

    router.post('/asset', express.json({ limit: NOTE_ASSET_JSON_LIMIT }), asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        res.status(201).json(await assetStore.saveAsset({
            notePath: requireString(body.notePath, 'invalid_note_path', 'notePath is required'),
            mime: requireString(body.mime, 'note_asset_unsupported_type', 'mime is required'),
            dataBase64: requireString(body.dataBase64, 'note_asset_invalid_base64', 'dataBase64 is required'),
        }));
    }));

    router.get('/asset', asyncRoute(async (req, res) => {
        const path = requireString(req.query.path, 'invalid_note_asset_path', 'path query is required');
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

    router.get('/file', asyncRoute(async (req, res) => {
        const path = requireString(req.query.path, 'invalid_note_path', 'path query is required');
        res.json(await store.readFile(path));
    }));

    router.post('/file', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const path = requireString(body.path, 'invalid_note_path', 'path is required');
        res.status(201).json(await store.createFile(path, optionalString(body.content) || ''));
    }));

    router.put('/file', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const request: DashboardPutNoteRequest = {
            path: requireString(body.path, 'invalid_note_path', 'path is required'),
            content: requireString(body.content, 'invalid_note_content', 'content is required'),
            baseRevision: optionalString(body.baseRevision),
        };
        res.json(await store.writeFile(request));
    }));

    router.post('/folder', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const path = requireString(body.path, 'invalid_note_folder_path', 'path is required');
        res.status(201).json(await store.createFolder(path));
    }));

    router.post('/rename', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const from = requireString(body.from, 'invalid_note_path', 'from is required');
        const to = requireString(body.to, 'invalid_note_path', 'to is required');
        res.json(await store.rename(from, to));
    }));

    router.post('/trash', asyncRoute(async (req, res) => {
        const body = bodyObject(req);
        const path = requireString(body.path, 'invalid_note_path', 'path is required');
        const kind = optionalTrashKind(body.kind);
        res.json(await trash.trashPath(store.rootPath(), path, kind));
    }));

    return router;
}
