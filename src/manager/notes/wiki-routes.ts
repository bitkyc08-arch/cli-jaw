// Manager access to an instance's wiki (devlog 041-C).
//
// The generic /i proxy could carry these requests — it validates the port range and
// passes JSON through untouched — but it opens its own loopback connection, and an
// instance treats loopback as already authenticated before it inspects any token. Routing
// the vault that way would mean anything able to reach the manager could read it, so this
// route exists to put a real boundary in front. What it owns is exactly that boundary,
// the check that the target instance is actually up, and one honest error when it is not;
// the transport underneath is the same shape the proxy already uses.

import express, { type Request, type Response, type RequestHandler } from 'express';
import http from 'node:http';
import { notesCorsPreflight, requireNotesAuth } from './auth.js';
import { dashboardProxyRange, isDashboardProxyPortAllowed } from '../proxy.js';

const CORE_HOST = '127.0.0.1';
/** One answer for every way the instance can be absent, so callers need only handle one. */
const UNAVAILABLE = { ok: false, error: 'wiki_core_unavailable' } as const;

type InstanceRow = { port: number; ok?: boolean; status?: string };
type ScanResult = { instances: InstanceRow[] };

export type DashboardWikiRouterOptions = {
    managerPort: number;
    settingsPath?: string;
    /** Port range the manager manages; the same helper the /i proxy uses decides it. */
    range?: { from?: number; count?: number };
    /** Supplies the current instance scan. Injected so a test can drive liveness. */
    scanSupplier: () => Promise<ScanResult>;
    requestImpl?: typeof http.request;
};

function parsePort(raw: unknown): number | null {
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 ? port : null;
}

/** Only these reach an instance. A path the caller invents does not. */
const ALLOWED_SUFFIXES = new Set(['status', 'entities']);

export function createDashboardWikiRouter(options: DashboardWikiRouterOptions): express.Router {
    const router = express.Router();
    const range = dashboardProxyRange(options.range ?? {});
    const request = options.requestImpl ?? http.request;
    const settingsPath = options.settingsPath || '';

    // Same pair, same order as the notes router: loopback alone is not enough.
    router.use(notesCorsPreflight({ managerPort: options.managerPort, settingsPath }) as RequestHandler);
    router.use(requireNotesAuth({ managerPort: options.managerPort, settingsPath }) as RequestHandler);

    router.get('/:suffix', async (req: Request, res: Response) => {
        const suffix = String(req.params["suffix"] || '');
        if (!ALLOWED_SUFFIXES.has(suffix)) {
            res.status(404).json({ ok: false, error: 'wiki_route_unknown' });
            return;
        }
        const port = parsePort(req.query["port"]);
        // Range first, using the proxy's own check rather than a second copy of it: two
        // implementations of "which ports may we talk to" is how one of them drifts into
        // an open relay.
        if (port === null || !isDashboardProxyPortAllowed(port, range)) {
            res.status(503).json(UNAVAILABLE);
            return;
        }

        // Then liveness. An instance that is not up must not have a connection opened to
        // it at all, so the answer here is decided before any socket exists.
        let scan: ScanResult;
        try {
            scan = await options.scanSupplier();
        } catch {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        const row = scan.instances.find(instance => instance.port === port);
        if (!row || row.ok !== true || row.status !== 'online') {
            res.status(503).json(UNAVAILABLE);
            return;
        }

        const upstream = request({
            hostname: CORE_HOST,
            port,
            method: 'GET',
            path: `/api/wiki/${suffix}`,
            headers: { host: `${CORE_HOST}:${port}`, accept: 'application/json' },
        }, upstreamRes => {
            res.status(upstreamRes.statusCode || 502);
            res.setHeader('content-type', upstreamRes.headers['content-type'] || 'application/json');
            upstreamRes.pipe(res);
        });

        // The scan is up to ten seconds stale, so an instance can die between being
        // reported online and being dialled. That is the same absence as the ones above
        // and gets the same answer, rather than a transport error the caller has to guess at.
        upstream.on('error', () => {
            if (!res.headersSent) res.status(503).json(UNAVAILABLE);
            else res.end();
        });
        upstream.end();
    });

    return router;
}
