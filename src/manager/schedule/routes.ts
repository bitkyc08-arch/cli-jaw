import { Router, type Request, type Response } from 'express';
import { stripUndefined } from '../../core/strip-undefined.js';
import { ScheduleStore, type DashboardScheduledWorkInput, type DashboardScheduledWorkPatch } from './store.js';
import { dispatchScheduledWork } from './dispatcher.js';

export type DashboardScheduleRouterOptions = { store?: ScheduleStore };

function sendErr(res: Response, status: number, code: string, error: unknown) {
    res.status(status).json({
        ok: false,
        code,
        error: error instanceof Error ? error.message : String(error),
    });
}

function pickInput(body: Record<string, unknown>): DashboardScheduledWorkInput {
    return stripUndefined({
        title: typeof body["title"] === 'string' ? body["title"] : '',
        group: typeof body["group"] === 'string' ? body["group"] as DashboardScheduledWorkInput['group'] : undefined,
        cron: typeof body["cron"] === 'string' ? body["cron"] : null,
        runAt: typeof body["runAt"] === 'string' ? body["runAt"] : null,
        targetPort: typeof body["targetPort"] === 'number' ? body["targetPort"] : null,
        payload: typeof body["payload"] === 'string' ? body["payload"] : null,
        enabled: typeof body["enabled"] === 'boolean' ? body["enabled"] : true,
    });
}

function pickPatch(body: Record<string, unknown>): DashboardScheduledWorkPatch {
    const p: DashboardScheduledWorkPatch = {};
    if (typeof body["title"] === 'string') p.title = body["title"];
    if (typeof body["group"] === 'string') p.group = body["group"] as NonNullable<DashboardScheduledWorkPatch['group']>;
    if ('cron' in body) p.cron = typeof body["cron"] === 'string' ? body["cron"] : null;
    if ('runAt' in body) p.runAt = typeof body["runAt"] === 'string' ? body["runAt"] : null;
    if ('targetPort' in body) p.targetPort = typeof body["targetPort"] === 'number' ? body["targetPort"] : null;
    if ('payload' in body) p.payload = typeof body["payload"] === 'string' ? body["payload"] : null;
    if (typeof body["enabled"] === 'boolean') p.enabled = body["enabled"];
    return p;
}

export function createDashboardScheduleRouter(options: DashboardScheduleRouterOptions = {}): Router {
    const router = Router();
    const store = options.store || new ScheduleStore();

    router.get('/work', (_req: Request, res: Response) => {
        try { res.json({ ok: true, items: store.list() }); }
        catch (e) { sendErr(res, 500, 'schedule_list_failed', e); }
    });

    router.post('/work', (req: Request, res: Response) => {
        try {
            const input = pickInput((req.body || {}) as Record<string, unknown>);
            const item = store.create(input);
            res.status(201).json({ ok: true, item });
        } catch (e) { sendErr(res, 400, 'schedule_create_failed', e); }
    });

    router.patch('/work/:id', (req: Request, res: Response) => {
        try {
            const id = String(req.params["id"] || '');
            const patch = pickPatch((req.body || {}) as Record<string, unknown>);
            const item = store.update(id, patch);
            if (!item) { sendErr(res, 404, 'schedule_item_not_found', 'not found'); return; }
            res.json({ ok: true, item });
        } catch (e) { sendErr(res, 400, 'schedule_update_failed', e); }
    });

    router.delete('/work/:id', (req: Request, res: Response) => {
        try {
            const id = String(req.params["id"] || '');
            const removed = store.remove(id);
            if (!removed) { sendErr(res, 404, 'schedule_item_not_found', 'not found'); return; }
            res.json({ ok: true });
        } catch (e) { sendErr(res, 500, 'schedule_delete_failed', e); }
    });

    router.post('/work/:id/dispatch', (req: Request, res: Response) => {
        try {
            const id = String(req.params["id"] || '');
            const item = store.get(id);
            if (!item) { sendErr(res, 404, 'schedule_item_not_found', 'not found'); return; }
            const body = (req.body || {}) as Record<string, unknown>;
            const rawBusy = Array.isArray(body["busyPorts"]) ? body["busyPorts"] : [];
            const busyPorts = rawBusy
                .map(v => (typeof v === 'number' ? v : Number(v)))
                .filter(n => Number.isFinite(n) && n > 0);
            const result = dispatchScheduledWork(item, { busyPorts });
            let updated = item;
            if (result.status === 'dispatched') {
                // Atomic claim: serialize concurrent dispatches AND guard against
                // PATCH-driven mutation of enabled/targetPort between decision and claim.
                const claim = store.claimForDispatch(id, { enabled: item.enabled, targetPort: item.targetPort });
                if (claim.ok) {
                    updated = claim.item;
                } else {
                    res.json({
                        ok: true,
                        result: {
                            status: 'queued',
                            message: claim.reason === 'gone' ? 'item removed before dispatch' : 'item changed before dispatch (re-check and retry)',
                            targetPort: result.targetPort,
                        },
                        item: store.get(id) || item,
                    });
                    return;
                }
            }
            res.json({ ok: true, result, item: updated });
        } catch (e) { sendErr(res, 500, 'schedule_dispatch_failed', e); }
    });

    return router;
}
