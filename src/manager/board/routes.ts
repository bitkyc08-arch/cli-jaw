import { Router, type Request, type Response } from 'express';
import { BoardStore, type DashboardTaskInput, type DashboardTaskPatch } from './store.js';

export type DashboardBoardRouterOptions = { store?: BoardStore };

function sendErr(res: Response, status: number, code: string, error: unknown) {
    res.status(status).json({
        ok: false,
        code,
        error: error instanceof Error ? error.message : String(error),
    });
}

function pickInput(body: Record<string, unknown>): DashboardTaskInput {
    return {
        title: typeof body.title === 'string' ? body.title : '',
        summary: typeof body.summary === 'string' ? body.summary : null,
        detail: typeof body.detail === 'string' ? body.detail : null,
        lane: typeof body.lane === 'string' ? body.lane as DashboardTaskInput['lane'] : undefined,
        port: typeof body.port === 'number' ? body.port : null,
        threadKey: typeof body.threadKey === 'string' ? body.threadKey : null,
        notePath: typeof body.notePath === 'string' ? body.notePath : null,
        source: typeof body.source === 'string' ? body.source : undefined,
    };
}

function pickPatch(body: Record<string, unknown>): DashboardTaskPatch {
    const patch: DashboardTaskPatch = {};
    if (typeof body.title === 'string') patch.title = body.title;
    if ('summary' in body) patch.summary = typeof body.summary === 'string' ? body.summary : null;
    if ('detail' in body) patch.detail = typeof body.detail === 'string' ? body.detail : null;
    if (typeof body.lane === 'string') patch.lane = body.lane as DashboardTaskPatch['lane'];
    if ('port' in body) patch.port = typeof body.port === 'number' ? body.port : null;
    if ('threadKey' in body) patch.threadKey = typeof body.threadKey === 'string' ? body.threadKey : null;
    if ('notePath' in body) patch.notePath = typeof body.notePath === 'string' ? body.notePath : null;
    return patch;
}

export function createDashboardBoardRouter(options: DashboardBoardRouterOptions = {}): Router {
    const router = Router();
    const store = options.store || new BoardStore();

    router.get('/tasks', (_req: Request, res: Response) => {
        try { res.json({ ok: true, tasks: store.list() }); }
        catch (e) { sendErr(res, 500, 'board_list_failed', e); }
    });

    router.post('/tasks', (req: Request, res: Response) => {
        try {
            const input = pickInput((req.body || {}) as Record<string, unknown>);
            const task = store.create(input);
            res.status(201).json({ ok: true, task });
        } catch (e) { sendErr(res, 400, 'board_create_failed', e); }
    });

    router.patch('/tasks/:id', (req: Request, res: Response) => {
        try {
            const id = String(req.params.id || '');
            const patch = pickPatch((req.body || {}) as Record<string, unknown>);
            const task = store.update(id, patch);
            if (!task) { sendErr(res, 404, 'board_task_not_found', 'not found'); return; }
            res.json({ ok: true, task });
        } catch (e) { sendErr(res, 400, 'board_update_failed', e); }
    });

    router.delete('/tasks/:id', (req: Request, res: Response) => {
        try {
            const id = String(req.params.id || '');
            const removed = store.remove(id);
            if (!removed) { sendErr(res, 404, 'board_task_not_found', 'not found'); return; }
            res.json({ ok: true });
        } catch (e) { sendErr(res, 500, 'board_delete_failed', e); }
    });

    router.post('/tasks/from-message', (req: Request, res: Response) => {
        try {
            const body = (req.body || {}) as Record<string, unknown>;
            const port = typeof body.port === 'number' ? body.port : Number(body.port);
            if (!Number.isFinite(port) || port <= 0) {
                sendErr(res, 400, 'board_invalid_port', 'port required'); return;
            }
            const threadKey = typeof body.threadKey === 'string' ? body.threadKey : null;
            const titleRaw = typeof body.title === 'string' ? body.title.trim() : '';
            const title = titleRaw || (threadKey ? `Thread @ :${port}` : `Instance :${port}`);
            const lane = typeof body.lane === 'string' ? body.lane as DashboardTaskInput['lane'] : 'inbox';
            const task = store.create({
                title,
                lane,
                port,
                threadKey,
                source: 'message',
            });
            res.status(201).json({ ok: true, task });
        } catch (e) { sendErr(res, 400, 'board_from_message_failed', e); }
    });

    return router;
}
