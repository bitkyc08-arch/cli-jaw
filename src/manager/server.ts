import express from 'express';
import helmet from 'helmet';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DASHBOARD_DEFAULT_PORT,
    MANAGED_INSTANCE_PORT_COUNT,
    MANAGED_INSTANCE_PORT_FROM,
} from './constants.js';
import { defaultPreviewFromForManagerPort } from './preview-ports.js';
import { scanDashboardInstances, scanSinglePort, scanPeerDashboards } from './scan.js';
import { InstanceRegistry } from './instance-registry.js';
import { installDashboardProxy } from './proxy.js';
import { createPreviewOriginProxyController } from './preview-origin-proxy.js';
import { DashboardLifecycleManager } from './lifecycle.js';
import { createDashboardShutdown } from './shutdown.js';
import { PLANNED_RESTART_CODE } from '../core/process-codes.js';
import { killAllAgents } from '../agent/spawn.js';
import { parsePositiveCount, parsePositivePort } from './security.js';
import {
    applyDashboardRegistry,
    loadDashboardRegistry,
    patchDashboardRegistry,
} from './registry.js';
import { createHealthHistory, type HealthEvent } from './health-history.js';
import { createObservability } from './observability.js';
import { fetchInstanceLogs } from './logs.js';
import {
    createDashboardNotesRouter,
} from './notes/routes.js';
import { SETTINGS_PATH } from '../core/config.js';
import { createNotesWatcher } from './notes/watcher.js';
import { NoteWsServer } from './notes/ws.js';
import { NotesStore } from './notes/store.js';
import { createDesktopStatusRouter } from './routes/desktop-status.js';
import { createElectronMetricsRouter } from './routes/electron-metrics.js';
import { createDashboardBoardRouter } from './board/routes.js';
import { createDashboardScheduleRouter } from './schedule/routes.js';
import { ScheduleStore } from './schedule/store.js';
import { startScheduleRunner } from './schedule/runner.js';
import { createDashboardRemindersRouter } from './reminders/routes.js';
import { RemindersStore } from './reminders/store.js';
import { startRemindersScheduler } from './reminders/scheduler.js';
import { createDashboardConnectorRouter } from './connector/routes.js';
import { createDashboardMemoryRouter } from './routes/dashboard-memory.js';
import { createDashboardGitRouter } from './routes/dashboard-git.js';
import { VecStore, getVecDbPath, createProvider, syncAllInstances } from './memory/embedding/index.js';
import type { EmbeddingConfig } from './memory/embedding/index.js';
import { addBroadcastListener } from '../core/bus.js';
import { subscribe as subscribeManagerBus } from '../core/event-bus.js';
import { resolveDashboardHome } from './dashboard-home.js';
import { fetchWorkerAssistantTextById } from './worker-messages.js';
import {
    startWorkerEventBridge, stopWorkerEventBridge,
    getCachedLatestMessage, type WorkerLatestData,
} from './worker-events.js';
import { openUrlInBrowser } from '../core/browser-open.js';
import { ensureDirs, loadSettings } from '../core/config.js';
import { createJawCeoRouter } from '../routes/jaw-ceo.js';
import { registerCodeRoutes } from '../routes/code.js';
import type {
    DashboardInstance,
    DashboardServiceState,
    DashboardLifecycleAction,
    DashboardLifecycleResult,
    DashboardRegistryPatch,
    DashboardScanResult,
} from './types.js';
import { detectAllServiceStates, detectServiceState, isServiceSupported } from './platform-service.js';
import { defaultHomeForPort } from './lifecycle-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, '..', '..');
const projectRoot = existsSync(join(serverRoot, 'package.json'))
    ? serverRoot
    : join(serverRoot, '..');
const app = express();
ensureDirs();
loadSettings();

const port = parsePositivePort(process.env["DASHBOARD_PORT"], Number(DASHBOARD_DEFAULT_PORT));
const scanFrom = parsePositivePort(process.env["DASHBOARD_SCAN_FROM"], MANAGED_INSTANCE_PORT_FROM);
const scanCount = parsePositiveCount(
    process.env["DASHBOARD_SCAN_COUNT"],
    MANAGED_INSTANCE_PORT_COUNT,
    MANAGED_INSTANCE_PORT_COUNT,
);
const previewFrom = parsePositivePort(
    process.env["DASHBOARD_PREVIEW_FROM"],
    defaultPreviewFromForManagerPort(port, scanCount),
);
const previewTimeoutMs = parsePositiveCount(process.env["DASHBOARD_PREVIEW_TIMEOUT_MS"], 30_000, 120_000);
const lifecycle = new DashboardLifecycleManager({
    managerPort: port,
    from: scanFrom,
    count: scanCount,
});
const healthHistory = createHealthHistory();
const observability = createObservability();
const previewProxy = createPreviewOriginProxyController({
    scanFrom,
    scanCount,
    previewFrom,
    managerPort: port,
    bindHost: '127.0.0.1',
    requestTimeoutMs: previewTimeoutMs,
});
const previousStatusByPort = new Map<number, { status: string; version: string | null }>();

function managerPreviewMicPermissionPolicy(): string {
    const origins: string[] = [];
    for (let offset = 0; offset < scanCount; offset += 1) {
        const previewPort = previewFrom + offset;
        origins.push(`"http://127.0.0.1:${previewPort}"`);
        origins.push(`"http://localhost:${previewPort}"`);
    }
    return `microphone=(self ${origins.join(' ')})`;
}

const managerPermissionsPolicy = managerPreviewMicPermissionPolicy();

async function serviceDetect(range: { from: number; to: number }): Promise<Map<number, DashboardServiceState>> {
    return detectAllServiceStates(range);
}

async function serviceDetectSingle(port: number, home?: string): Promise<DashboardServiceState | null> {
    if (!isServiceSupported()) return null;
    return detectServiceState(port, home || defaultHomeForPort(port));
}

function recordScanEvents(result: DashboardScanResult): void {
    const at = result.manager.checkedAt;
    let reachable = 0;
    for (const instance of result.instances) {
        if (instance.ok) reachable += 1;
        const previous = previousStatusByPort.get(instance.port);
        if (previous && previous.status !== instance.status) {
            observability.publish({
                kind: 'health-changed',
                port: instance.port,
                from: previous.status as DashboardInstance['status'],
                to: instance.status,
                reason: instance.healthReason,
                at,
            });
        }
        if (previous && previous.version && instance.version && previous.version !== instance.version) {
            observability.publish({
                kind: 'version-mismatch',
                port: instance.port,
                expected: previous.version,
                seen: instance.version,
                at,
            });
        }
        const event: HealthEvent = {
            port: instance.port,
            at,
            status: instance.status,
            reason: instance.healthReason,
            versionSeen: instance.version,
        };
        healthHistory.record(event);
        previousStatusByPort.set(instance.port, { status: instance.status, version: instance.version });
    }
    observability.publish({
        kind: 'scan-completed',
        from: result.manager.rangeFrom,
        to: result.manager.rangeTo,
        reachable,
        at,
    });
}

function attachPreviewSnapshot(result: DashboardScanResult): DashboardScanResult {
    result.manager.proxy.preview = previewProxy.snapshot();
    return result;
}

// Phase 4a (devlog 260609, 40): background scan cache. Full-scan call sites
// (instances list, memory supplier, jaw-ceo) read this snapshot; single-port
// (:port) and git-router scans stay live for lifecycle pollUntilSettled freshness.
const instanceRegistry = new InstanceRegistry({
    scan: async () => {
        const loaded = loadDashboardRegistry({ from: scanFrom, count: scanCount });
        return scanDashboardInstances({
            from: loaded.registry.scan.from,
            count: loaded.registry.scan.count,
            managerPort: port,
        });
    },
    onScanResult: async (result) => {
        recordScanEvents(result);
        await previewProxy.reconcileOnlineTargets(
            result.instances.filter(instance => instance.ok).map(instance => instance.port)
        );
    },
});

async function cachedFullScan(): Promise<DashboardScanResult> {
    return instanceRegistry.isReady()
        ? instanceRegistry.snapshot()!
        : instanceRegistry.forceRefresh();
}

// Phase 4b (devlog 260609, 41 P3): peer dashboard scan is up to 14 sequential
// ports × 450ms in the request path — cache with a 30s TTL. Peers change
// rarely; ?fresh=1 resets the TTL alongside the instance refresh.
let peerCache: DashboardInstance[] = [];
let peerCacheAt = 0;
const PEER_CACHE_TTL_MS = 30_000;

async function cachedPeerDashboards(): Promise<DashboardInstance[]> {
    if (Date.now() - peerCacheAt < PEER_CACHE_TTL_MS) return peerCache;
    try {
        peerCache = await scanPeerDashboards(port);
        peerCacheAt = Date.now();
    } catch { /* keep the previous cache on scan failure */ }
    return peerCache;
}

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));
const notesStore = new NotesStore();
const notesWatcher = createNotesWatcher(notesStore.rootPath());
let noteWsServerRef: NoteWsServer | null = null;
const wsTokenIssuer = { issueToken: () => { if (!noteWsServerRef) throw new Error('WS not ready'); return noteWsServerRef.issueToken(); } };
app.use(
    '/api/dashboard/notes',
    createDashboardNotesRouter({ managerPort: port, settingsPath: SETTINGS_PATH, store: notesStore, watcher: notesWatcher, wsTokenIssuer }),
);
const dashboardJsonParser = express.json({ limit: '64kb' });
app.use((req, res, next) => {
    // Legacy /i/:port proxy streams the raw request body upstream. express.json()
    // consumes the stream first and leaves POST /api/message hanging forever.
    if (/^\/i\/\d+(?:\/|$)/.test(req.path)) return next();
    return dashboardJsonParser(req, res, next);
});
app.use('/api/dashboard/desktop-status', createDesktopStatusRouter());
app.use('/api/dashboard/electron-metrics', createElectronMetricsRouter());
app.use('/api/dashboard/board', createDashboardBoardRouter());
const scheduleStore = new ScheduleStore();
app.use('/api/dashboard/schedule', createDashboardScheduleRouter({ store: scheduleStore }));
const remindersStore = new RemindersStore();
app.use('/api/dashboard/reminders', createDashboardRemindersRouter({ store: remindersStore }));
app.use('/api/dashboard/connector', createDashboardConnectorRouter({ remindersStore }));

const dashboardHome = resolveDashboardHome();
app.use('/api/dashboard/git', createDashboardGitRouter({
    homePath: dashboardHome,
    resolveInstance: async (instancePort: number) => {
        if (instancePort < scanFrom || instancePort >= scanFrom + scanCount) return null;
        return await scanSinglePort(instancePort);
    },
}));

function loadEmbeddingConfig(): EmbeddingConfig | null {
    const p = join(dashboardHome, 'embedding.json');
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, 'utf8')) as EmbeddingConfig;
    } catch { return null; }
}

let vecStoreInstance: VecStore | null = null;
function getVecStore(config: EmbeddingConfig | null): VecStore | null {
    if (!config?.enabled) return null;
    if (!vecStoreInstance) {
        try {
            vecStoreInstance = new VecStore(getVecDbPath(dashboardHome), config.dimensions);
        } catch (err) {
            console.warn('[embedding] Failed to initialize VecStore:', err);
            return null;
        }
    }
    return vecStoreInstance;
}

const memoryScanSupplier = async () => {
    // Phase 4a: cached registry replaces the per-call 150-fetch full scan (09 P6/P7)
    const scan = await cachedFullScan();
    return scan.instances.map(i => ({
        port: i.port,
        profileId: i.profileId ?? null,
        homeDisplay: i.homeDisplay ?? null,
    }));
};
app.use('/api/dashboard/memory', createDashboardMemoryRouter({
    managerPort: port,
    scanSupplier: memoryScanSupplier,
    embeddingConfig: () => loadEmbeddingConfig(),
    vecStore: () => getVecStore(loadEmbeddingConfig()),
    dashboardHome,
}));

// Embedding auto-sync: debounced incremental sync on memory saves
let embeddingSyncTimeout: ReturnType<typeof setTimeout> | null = null;
addBroadcastListener((type, data) => {
    if (type !== 'memory_status' || data['reason'] !== 'save') return;
    const config = loadEmbeddingConfig();
    if (!config?.enabled) return;
    const vec = getVecStore(config);
    if (!vec) return;
    if (embeddingSyncTimeout) clearTimeout(embeddingSyncTimeout);
    embeddingSyncTimeout = setTimeout(async () => {
        embeddingSyncTimeout = null;
        try {
            const provider = await createProvider(config);
            const scan = await memoryScanSupplier();
            const { listSearchableInstancesFromScan } = await import('./memory/instance-discovery.js');
            const instances = listSearchableInstancesFromScan(scan);
            await syncAllInstances({ instances, vecStore: vec, provider });
            vec.setConfig('lastSyncAt', new Date().toISOString());
        } catch (err) {
            console.error('[embedding] auto-sync failed:', err);
        }
    }, 2000);
});

// 30-minute background catchall sync
setInterval(async () => {
    const config = loadEmbeddingConfig();
    if (!config?.enabled) return;
    const vec = getVecStore(config);
    if (!vec) return;
    try {
        const provider = await createProvider(config);
        const scan = await memoryScanSupplier();
        const { listSearchableInstancesFromScan } = await import('./memory/instance-discovery.js');
        const instances = listSearchableInstancesFromScan(scan);
        await syncAllInstances({ instances, vecStore: vec, provider });
        vec.setConfig('lastSyncAt', new Date().toISOString());
    } catch (err) {
        console.error('[embedding] background sync failed:', err);
    }
}, 30 * 60 * 1000);

let stopRemindersScheduler: (() => void) | null = null;

app.use('/api/jaw-ceo', createJawCeoRouter({
    repoRoot: projectRoot,
    listInstances: async () => {
        const loaded = loadDashboardRegistry({ from: scanFrom, count: scanCount });
        // Phase 4a: cached registry instead of a fresh 150-fetch scan (09 P1)
        const result = await cachedFullScan();
        const serviceStates = await serviceDetect({
            from: loaded.registry.scan.from,
            to: loaded.registry.scan.from + loaded.registry.scan.count - 1,
        });
        const decorated = lifecycle.decorateScanResult(result, serviceStates);
        const applied = applyDashboardRegistry(attachPreviewSnapshot(decorated), loaded.registry, loaded.status, { showHidden: false });
        return applied.instances.map(instance => ({
            port: instance.port,
            label: instance.label || instance.profileId || `:${instance.port}`,
            status: instance.status,
            ok: instance.ok,
            url: instance.url,
            currentCli: instance.currentCli,
            currentModel: instance.currentModel,
            workingDir: instance.workingDir,
        }));
    },
    fetchLatestMessage: async (targetPort) => {
        // P4-full (devlog 260609, 50 §2): serve from the SSE-fed cache while the
        // worker's event stream is live; otherwise fall back to on-demand fetch.
        const cached = getCachedLatestMessage(targetPort);
        let data: WorkerLatestData;
        if (cached !== undefined) {
            data = cached;
        } else {
            const response = await fetch(`http://127.0.0.1:${targetPort}/api/messages/latest?includeContent=1`);
            if (!response.ok) return null;
            const body = await response.json() as { ok?: boolean; data?: WorkerLatestData };
            data = body.data ?? null;
        }
        const latest = data?.latestAssistant;
        const latestId = latest?.id ? Number(latest.id) : null;
        const directText = latest && typeof latest.text === 'string' ? latest.text : String(latest?.content || '');
        const fallbackText = latestId && !directText.trim()
            ? await fetchWorkerAssistantTextById(fetch, targetPort, latestId).catch(() => '')
            : '';
        return {
            latestAssistant: latest && latestId ? {
                id: latestId,
                role: 'assistant',
                ...(latest.created_at ? { created_at: String(latest.created_at) } : {}),
                text: directText || fallbackText,
            } : null,
            activity: data?.activity?.messageId ? {
                messageId: Number(data.activity.messageId),
                role: String(data.activity.role || ''),
                ...(data.activity.title ? { title: String(data.activity.title) } : {}),
                ...(data.activity.updatedAt ? { updatedAt: String(data.activity.updatedAt) } : {}),
            } : null,
        };
    },
    sendWorkerMessage: async ({ port: targetPort, prompt }) => {
        const response = await fetch(`http://127.0.0.1:${targetPort}/api/message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const data = await response.json().catch(() => null) as unknown;
        return {
            ok: response.ok,
            status: response.status,
            message: response.ok ? 'sent' : `worker send failed: ${response.status}`,
            data,
        };
    },
    runLifecycleAction: async ({ action, port: targetPort }) => {
        // Direct call — no loopback self-fetch (devlog 260609, 09 P5 / 41).
        try {
            const data = await runDashboardLifecycleAction(action as DashboardLifecycleAction, targetPort);
            return {
                ok: Boolean(data.ok),
                message: data.message || `lifecycle ${action} failed: ${data.status}`,
                ...(data.status ? { status: data.status } : {}),
                data,
            };
        } catch (error) {
            return {
                ok: false,
                message: `lifecycle ${action} failed: ${(error as Error).message}`,
                data: null,
            };
        }
    },
}));

// Electron Code mode is a manager-local workbench. Register the Code REST API
// on the manager server before the SPA fallback so /api/code/* never resolves
// to index.html.
registerCodeRoutes(app, (_req, _res, next) => next());

app.get('/api/dashboard/health', (_req, res) => {
    res.json({
        ok: true,
        app: 'cli-jaw',
        service: 'manager-dashboard',
        port,
        pid: process.pid,
        rangeFrom: scanFrom,
        rangeTo: scanFrom + scanCount - 1,
    });
});

app.get('/api/dashboard/instances', async (req, res) => {
    try {
        const loaded = loadDashboardRegistry({ from: scanFrom, count: scanCount });
        const from = Number(req.query["from"] || loaded.registry.scan.from);
        const count = Number(req.query["count"] || loaded.registry.scan.count);
        const showHidden = req.query["showHidden"] === '1' || req.query["showHidden"] === 'true';
        const isDefaultRange = from === loaded.registry.scan.from && count === loaded.registry.scan.count;
        const wantsFresh = req.query["fresh"] === '1' || req.query["fresh"] === 'true';
        let result: DashboardScanResult;
        if (!isDefaultRange) {
            // Custom range bypasses the cache (rare API path — default UI sends no from/count).
            // Keeps the full side-effect pipeline of the legacy inline scan.
            result = await scanDashboardInstances({ from, count, managerPort: port });
            recordScanEvents(result);
            await previewProxy.reconcileOnlineTargets(
                result.instances.filter(instance => instance.ok).map(instance => instance.port)
            );
        } else if (wantsFresh) {
            peerCacheAt = 0; // fresh refreshes the peer scan too (41 P3)
            result = await instanceRegistry.forceRefresh();
        } else {
            // Phase 4a: cached snapshot (≤10s stale by design — 09 §2 P1);
            // recordScanEvents/reconcile run in the registry's scan loop.
            result = await cachedFullScan();
        }
        const serviceStates = await serviceDetect({ from, to: from + count - 1 });
        const decorated = lifecycle.decorateScanResult(result, serviceStates);

        let peerDashboards: DashboardInstance[] = [];
        try {
            const peers = await cachedPeerDashboards();
            peerDashboards = peers.map(peer => lifecycle.decorateInstance(peer, null, true));
        } catch { /* peer scan is best-effort */ }

        const applied = applyDashboardRegistry(attachPreviewSnapshot(decorated), loaded.registry, loaded.status, { showHidden });
        res.json({ ...applied, peerDashboards, platform: process.platform });
    } catch (error) {
        observability.publish({ kind: 'scan-failed', reason: (error as Error).message, at: new Date().toISOString() });
        res.status(500).json({ ok: false, error: (error as Error).message });
    }
});

app.get('/api/dashboard/instances/:port', async (req, res) => {
    const portValue = Number(req.params.port);
    const isPeerDashboard = lifecycle.isDashboardPort(portValue) && portValue !== port;
    if (!isPeerDashboard && (!Number.isInteger(portValue) || portValue < scanFrom || portValue >= scanFrom + scanCount)) {
        res.status(400).json({ ok: false, error: 'port out of configured scan range' });
        return;
    }
    try {
        if (isPeerDashboard) {
            // Cache first; a miss falls through to a live scan so a just-started
            // peer is still discoverable before the TTL rolls over (41 P3).
            let peers = await cachedPeerDashboards();
            if (!peers.some(p => p.port === portValue)) {
                peerCacheAt = 0;
                peers = await cachedPeerDashboards();
            }
            const peer = peers.find(p => p.port === portValue);
            if (!peer) {
                res.json({ ok: true, instance: lifecycle.decorateInstance({ port: portValue, status: 'offline', ok: false, lastCheckedAt: new Date().toISOString() } as DashboardInstance, null, true), platform: process.platform });
                return;
            }
            res.json({ ok: true, instance: lifecycle.decorateInstance(peer, null, true), platform: process.platform });
            return;
        }
        const loaded = loadDashboardRegistry({ from: scanFrom, count: scanCount });
        const instance = await scanSinglePort(portValue);
        if (instance.ok) await previewProxy.ensureTarget(instance.port);
        const serviceStates = await serviceDetect({ from: portValue, to: portValue });
        const decorated = lifecycle.decorateScanResult({
            manager: {
                port,
                rangeFrom: scanFrom,
                rangeTo: scanFrom + scanCount - 1,
                checkedAt: instance.lastCheckedAt,
                proxy: { enabled: true, basePath: '/i', allowedFrom: scanFrom, allowedTo: scanFrom + scanCount - 1 },
            },
            instances: [instance],
        }, serviceStates);
        const applied = applyDashboardRegistry(attachPreviewSnapshot(decorated), loaded.registry, loaded.status, { showHidden: true });
        res.json({ ok: true, instance: applied.instances[0] || null, manager: applied.manager, platform: process.platform });
    } catch (error) {
        res.status(500).json({ ok: false, error: (error as Error).message });
    }
});

app.post('/api/dashboard/instances/:port/message', async (req, res) => {
    const portValue = Number(req.params.port);
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!Number.isInteger(portValue) || portValue < scanFrom || portValue >= scanFrom + scanCount) {
        res.status(400).json({ ok: false, error: 'port out of configured scan range' });
        return;
    }
    if (!prompt) {
        res.status(400).json({ ok: false, error: 'prompt must be a non-empty string' });
        return;
    }
    try {
        const response = await fetch(`http://127.0.0.1:${portValue}/api/message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const data = await response.json().catch(() => ({ error: `worker returned ${response.status}` })) as unknown;
        res.status(response.status).json(data);
    } catch (error) {
        res.status(502).json({ ok: false, error: (error as Error).message });
    }
});

// #233 follow-up: relay the native folder chooser to a worker so the manager
// UI can (re)assign that instance's project root. The worker's dialog blocks
// until the user answers — the long-lived request is expected.
app.post('/api/dashboard/instances/:port/project/pick', async (req, res) => {
    const portValue = Number(req.params.port);
    if (!Number.isInteger(portValue) || portValue < scanFrom || portValue >= scanFrom + scanCount) {
        res.status(400).json({ ok: false, error: 'port out of configured scan range' });
        return;
    }
    try {
        const response = await fetch(`http://127.0.0.1:${portValue}/api/project/pick`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        const data = await response.json().catch(() => ({ error: `worker returned ${response.status}` })) as unknown;
        res.status(response.status).json(data);
    } catch (error) {
        res.status(502).json({ ok: false, error: (error as Error).message });
    }
});

app.get('/api/manager/events', (req, res) => {
    const since = typeof req.query["since"] === 'string' && req.query["since"] ? req.query["since"] : null;
    if (since && Number.isNaN(Date.parse(since))) {
        res.status(400).json({ ok: false, error: 'since must be a valid ISO 8601 timestamp' });
        return;
    }
    res.json({ ok: true, events: observability.drain(since) });
});

// #233: live relay of manager-process bus events (worker_settings_change) so
// the manager UI refreshes instance metadata without waiting for a poll.
// Same exposure level as /api/manager/events above (local dashboard, no auth).
app.get('/api/manager/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const unsubscribe = subscribeManagerBus((entry) => {
        if (entry.topic !== 'worker' || entry.event !== 'worker_settings_change') return;
        res.write(`data: ${JSON.stringify({ topic: entry.topic, event: entry.event, data: entry.data })}\n\n`);
    });
    const ping = setInterval(() => { res.write(': ping\n\n'); }, 30_000);
    ping.unref?.();

    req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
    });
});

app.get('/api/manager/health-history/:port', (req, res) => {
    const portValue = Number(req.params.port);
    if (!Number.isInteger(portValue) || portValue < scanFrom || portValue >= scanFrom + scanCount) {
        res.status(400).json({ ok: false, error: 'port out of configured scan range' });
        return;
    }
    const limit = req.query["limit"] ? Math.max(1, Math.min(200, Number(req.query["limit"]))) : undefined;
    res.json({ ok: true, port: portValue, events: healthHistory.list(portValue, limit) });
});

app.get('/api/manager/instance-logs/:port', async (req, res) => {
    const portValue = Number(req.params.port);
    if (!Number.isInteger(portValue) || portValue < scanFrom || portValue >= scanFrom + scanCount) {
        res.status(400).json({ ok: false, error: 'port out of configured scan range' });
        return;
    }
    try {
        const snapshot = await fetchInstanceLogs(portValue);
        res.json({ ok: true, snapshot });
    } catch (error) {
        res.status(500).json({ ok: false, error: (error as Error).message });
    }
});

app.get('/api/dashboard/registry', (_req, res) => {
    const loaded = loadDashboardRegistry({ from: scanFrom, count: scanCount });
    res.json(loaded);
});

app.patch('/api/dashboard/registry', (req, res) => {
    try {
        const patch = req.body && typeof req.body === 'object'
            ? req.body as DashboardRegistryPatch
            : {};
        res.json(patchDashboardRegistry(patch, { from: scanFrom, count: scanCount }));
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: (error as Error).message,
        });
    }
});

// Shared by the HTTP route below and the jaw-ceo deps — the manager used to
// fetch its OWN lifecycle endpoint over HTTP for jaw-ceo actions (devlog 260609,
// 09 P5). Direct call removes that loopback round-trip.
function rejectedLifecycleResult(action: DashboardLifecycleAction, portValue: number, message: string): DashboardLifecycleResult {
    return {
        ok: false, action, port: portValue, status: 'rejected',
        message, home: null, pid: null, command: [],
    } as DashboardLifecycleResult;
}

async function runDashboardLifecycleAction(
    action: DashboardLifecycleAction,
    portValue: number,
    home?: string,
): Promise<DashboardLifecycleResult> {
    if (!['start', 'stop', 'restart', 'perm', 'unperm'].includes(action)) {
        return rejectedLifecycleResult(action, portValue, `Unsupported lifecycle action: ${action}`);
    }
    if (!Number.isInteger(portValue)) {
        return rejectedLifecycleResult(action, portValue, 'port must be an integer');
    }
    let result: DashboardLifecycleResult;
    if (action === 'perm') {
        result = await lifecycle.perm(portValue, home);
    } else if (action === 'unperm') {
        result = await lifecycle.unperm(portValue, home);
    } else {
        const serviceState = await serviceDetectSingle(portValue, home);
        result = action === 'start'
            ? await lifecycle.start(portValue, home, serviceState)
            : action === 'stop'
                ? await lifecycle.stop(portValue, serviceState)
                : await lifecycle.restart(portValue, serviceState);
    }
    observability.publish({
        kind: 'lifecycle-result',
        port: portValue,
        action,
        status: result.status,
        message: result.message,
        at: new Date().toISOString(),
    });
    return result;
}

app.post('/api/dashboard/lifecycle/:action', async (req, res) => {
    const action = String(req.params.action || '') as DashboardLifecycleAction;
    const portValue = Number(req.body?.port);
    const home = typeof req.body?.home === 'string' ? req.body.home : undefined;

    try {
        const result = await runDashboardLifecycleAction(action, portValue, home);
        if (result.status === 'rejected') {
            res.status(400).json(result);
            return;
        }
        res.status(result.ok ? 200 : 409).json(result);
    } catch (error) {
        res.status(500).json({
            ok: false,
            action,
            port: portValue,
            status: 'error',
            message: (error as Error).message,
            home: null,
            pid: null,
            command: [],
        });
    }
});

app.post('/api/dashboard/lifecycle/lock', async (req, res) => {
    const portValue = Number(req.body?.port);
    if (!Number.isInteger(portValue)) {
        res.status(400).json({ ok: false, error: 'port must be an integer' });
        return;
    }
    const result = await lifecycle.protectInstance(portValue);
    res.json({ ok: result, port: portValue, protected: result });
});

app.post('/api/dashboard/lifecycle/unlock', async (req, res) => {
    const portValue = Number(req.body?.port);
    if (!Number.isInteger(portValue)) {
        res.status(400).json({ ok: false, error: 'port must be an integer' });
        return;
    }
    const result = await lifecycle.unprotectInstance(portValue);
    res.json({ ok: result, port: portValue, protected: false });
});

app.get('/api/dashboard/process-control', (_req, res) => {
    res.json({ ok: true, state: lifecycle.processControlState() });
});

app.post('/api/dashboard/process-control/adopt', async (_req, res) => {
    try {
        const result = await lifecycle.hydrate();
        res.json({ ok: true, result, state: lifecycle.processControlState() });
    } catch (error) {
        res.status(500).json({ ok: false, error: (error as Error).message });
    }
});

app.post('/api/dashboard/process-control/stop-managed', async (_req, res) => {
    try {
        const results = await lifecycle.stopAll();
        res.json({ ok: true, results, state: lifecycle.processControlState() });
    } catch (error) {
        res.status(500).json({ ok: false, error: (error as Error).message });
    }
});

app.post('/api/dashboard/process-control/force-release', (_req, res) => {
    res.status(501).json({
        ok: false,
        error: 'Force release is planned but disabled until strict command/home ownership proof is implemented.',
    });
});

const distRoot = join(projectRoot, 'public', 'dist');
const sourceRoot = join(projectRoot, 'public');
const managerHtmlCandidates = [
    join(distRoot, 'manager', 'index.html'),
    join(distRoot, 'public', 'manager', 'index.html'),
    join(distRoot, 'manager.html'),
    join(sourceRoot, 'manager', 'index.html'),
];

function managerUiSource(htmlPath: string): 'dist' | 'source' {
    return htmlPath.startsWith(distRoot) ? 'dist' : 'source';
}

function sendManagerHtml(res: express.Response, htmlPath: string): void {
    res.setHeader('x-jaw-manager-ui', managerUiSource(htmlPath));
    res.setHeader('Permissions-Policy', managerPermissionsPolicy);
    res.sendFile(basename(htmlPath), { root: dirname(htmlPath) }, error => {
        if (!error || res.headersSent) return;

        console.error(`[dashboard] failed to serve manager html: ${error.message}`);
        res.status(500).send('manager dashboard failed to load');
    });
}

app.use('/dist', express.static(distRoot));
app.use('/assets', express.static(join(distRoot, 'assets')));
app.use('/icons', express.static(join(sourceRoot, 'icons')));
app.use('/manager', express.static(join(sourceRoot, 'manager'), { index: false }));

app.get('/.well-known/appspecific/com.chrome.devtools.json', (_req, res) => {
    res.status(204).end();
});

app.get('/favicon.ico', (_req, res) => {
    res.sendFile('icon-192.png', { root: join(sourceRoot, 'icons') }, error => {
        if (!error || res.headersSent) return;
        res.status(204).end();
    });
});

const server = http.createServer(app);
const noteWsServer = new NoteWsServer({ server, watcher: notesWatcher });
noteWsServerRef = noteWsServer;
installDashboardProxy(app, server, { from: scanFrom, count: scanCount });

app.get('/{*splat}', (_req, res) => {
    const htmlPath = managerHtmlCandidates.find(candidate => existsSync(candidate));
    if (!htmlPath) {
        res.status(500).send('manager dashboard has not been built');
        return;
    }
    sendManagerHtml(res, htmlPath);
});

server.on('error', (error: NodeJS.ErrnoException) => {
    void previewProxy.close();
    if (error.code === 'EADDRINUSE') {
        console.error(`[dashboard] port ${port} already in use`);
    } else {
        console.error(`[dashboard] listen error: ${error.message}`);
    }
    process.exit(1);
});

let plannedRestartCode: number | null = null;

const shutdown = createDashboardShutdown({
    lifecycle,
    previewProxy,
    server,
    exit: code => process.exit(plannedRestartCode ?? code),
});

async function shutdownDashboard(mode?: 'full' | 'locked-skip'): Promise<void> {
    stopWorkerEventBridge();
    instanceRegistry.stop();
    stopRemindersScheduler?.();
    noteWsServer.close();
    notesWatcher.close();
    await shutdown(mode ?? 'locked-skip');
}

process.once('SIGINT', () => void shutdownDashboard('locked-skip'));
process.once('SIGTERM', () => void shutdownDashboard('locked-skip'));

process.on('SIGUSR2', () => {
    console.log('[dashboard] SIGUSR2 received — planned restart');
    plannedRestartCode = PLANNED_RESTART_CODE;
    killAllAgents('planned-restart');
    void shutdownDashboard('full');
});

async function main(): Promise<void> {
    previewProxy.validate();
    try {
        const hydrated = await lifecycle.hydrate();
        if (hydrated.adopted > 0 || hydrated.pruned > 0) {
            console.log(`[dashboard] adopted ${hydrated.adopted} child instance(s), pruned ${hydrated.pruned} stale entry(ies)`);
        }
    } catch (error) {
        console.error(`[dashboard] hydrate failed: ${(error as Error).message}`);
    }
    server.listen(port, '127.0.0.1', () => {
        const url = `http://localhost:${port}`;
        console.log(`\n  Jaw Manager — ${url}`);
        console.log(`  Scanning: ${scanFrom}-${scanFrom + scanCount - 1}`);
        console.log(`  Preview: ${previewFrom}-${previewFrom + scanCount - 1}\n`);

        startScheduleRunner(scheduleStore, {
            log: msg => console.log(msg),
        });
        // Phase 4a: background scan loop feeding the instance cache (devlog 260609, 40)
        // P4-full: bridge must subscribe BEFORE the first scan publishes
        // 'appeared' diffs, or initial workers would never get SSE streams.
        startWorkerEventBridge();
        instanceRegistry.start();
        if (process.env["JAW_REMINDERS_SCHEDULER"] === '1') {
            stopRemindersScheduler = startRemindersScheduler({
                store: remindersStore,
                observability,
                log: msg => console.log(msg),
            });
            console.log('  Reminders scheduler: enabled');
        }

        if (process.env["JAW_DASHBOARD_OPEN"] === '1') {
            openUrlInBrowser(url, { logPrefix: 'dashboard' });
        }
    });
}

void main().catch(async (error: Error) => {
    await previewProxy.close();
    console.error(`[dashboard] startup failed: ${error.message}`);
    process.exit(1);
});
