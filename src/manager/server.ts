import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
    DASHBOARD_DEFAULT_PORT,
    DASHBOARD_PREVIEW_PORT_FROM,
    MANAGED_INSTANCE_PORT_COUNT,
    MANAGED_INSTANCE_PORT_FROM,
} from './constants.js';
import { scanDashboardInstances, scanSinglePort } from './scan.js';
import { installDashboardProxy } from './proxy.js';
import { createPreviewOriginProxyController } from './preview-origin-proxy.js';
import { DashboardLifecycleManager } from './lifecycle.js';
import { createDashboardShutdown } from './shutdown.js';
import { parsePositiveCount, parsePositivePort } from './security.js';
import {
    applyDashboardRegistry,
    loadDashboardRegistry,
    patchDashboardRegistry,
} from './registry.js';
import { createHealthHistory, type HealthEvent } from './health-history.js';
import { createObservability } from './observability.js';
import { fetchInstanceLogs } from './logs.js';
import type {
    DashboardInstance,
    DashboardLifecycleAction,
    DashboardRegistryPatch,
    DashboardScanResult,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, '..', '..');
const projectRoot = existsSync(join(serverRoot, 'package.json'))
    ? serverRoot
    : join(serverRoot, '..');
const app = express();

const port = parsePositivePort(process.env.DASHBOARD_PORT, Number(DASHBOARD_DEFAULT_PORT));
const scanFrom = parsePositivePort(process.env.DASHBOARD_SCAN_FROM, MANAGED_INSTANCE_PORT_FROM);
const scanCount = parsePositiveCount(
    process.env.DASHBOARD_SCAN_COUNT,
    MANAGED_INSTANCE_PORT_COUNT,
    MANAGED_INSTANCE_PORT_COUNT,
);
const previewFrom = parsePositivePort(process.env.DASHBOARD_PREVIEW_FROM, DASHBOARD_PREVIEW_PORT_FROM);
const lifecycle = new DashboardLifecycleManager({ from: scanFrom, count: scanCount });
const healthHistory = createHealthHistory();
const observability = createObservability();
const previewProxy = createPreviewOriginProxyController({
    scanFrom,
    scanCount,
    previewFrom,
    managerPort: port,
    bindHost: '127.0.0.1',
});
const previousStatusByPort = new Map<number, { status: string; version: string | null }>();

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

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '64kb' }));

app.get('/api/dashboard/health', (_req, res) => {
    res.json({
        ok: true,
        port,
        rangeFrom: scanFrom,
        rangeTo: scanFrom + scanCount - 1,
    });
});

app.get('/api/dashboard/instances', async (req, res) => {
    try {
        const loaded = loadDashboardRegistry({ from: scanFrom, count: scanCount });
        const from = Number(req.query.from || loaded.registry.scan.from);
        const count = Number(req.query.count || loaded.registry.scan.count);
        const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true';
        const result = await scanDashboardInstances({ from, count, managerPort: port });
        recordScanEvents(result);
        await previewProxy.reconcileOnlineTargets(
            result.instances.filter(instance => instance.ok).map(instance => instance.port)
        );
        const decorated = lifecycle.decorateScanResult(result);
        res.json(applyDashboardRegistry(attachPreviewSnapshot(decorated), loaded.registry, loaded.status, { showHidden }));
    } catch (error) {
        observability.publish({ kind: 'scan-failed', reason: (error as Error).message, at: new Date().toISOString() });
        res.status(500).json({ ok: false, error: (error as Error).message });
    }
});

app.get('/api/dashboard/instances/:port', async (req, res) => {
    const portValue = Number(req.params.port);
    if (!Number.isInteger(portValue) || portValue < scanFrom || portValue >= scanFrom + scanCount) {
        return res.status(400).json({ ok: false, error: 'port out of configured scan range' });
    }
    try {
        const loaded = loadDashboardRegistry({ from: scanFrom, count: scanCount });
        const instance = await scanSinglePort(portValue);
        if (instance.ok) await previewProxy.ensureTarget(instance.port);
        const decorated = lifecycle.decorateScanResult({
            manager: {
                port,
                rangeFrom: scanFrom,
                rangeTo: scanFrom + scanCount - 1,
                checkedAt: instance.lastCheckedAt,
                proxy: { enabled: true, basePath: '/i', allowedFrom: scanFrom, allowedTo: scanFrom + scanCount - 1 },
            },
            instances: [instance],
        });
        const applied = applyDashboardRegistry(attachPreviewSnapshot(decorated), loaded.registry, loaded.status, { showHidden: true });
        res.json({ ok: true, instance: applied.instances[0] || null, manager: applied.manager });
    } catch (error) {
        res.status(500).json({ ok: false, error: (error as Error).message });
    }
});

app.get('/api/manager/events', (req, res) => {
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : null;
    if (since && Number.isNaN(Date.parse(since))) {
        return res.status(400).json({ ok: false, error: 'since must be a valid ISO 8601 timestamp' });
    }
    res.json({ ok: true, events: observability.drain(since) });
});

app.get('/api/manager/health-history/:port', (req, res) => {
    const portValue = Number(req.params.port);
    if (!Number.isInteger(portValue) || portValue < scanFrom || portValue >= scanFrom + scanCount) {
        return res.status(400).json({ ok: false, error: 'port out of configured scan range' });
    }
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : undefined;
    res.json({ ok: true, port: portValue, events: healthHistory.list(portValue, limit) });
});

app.get('/api/manager/instance-logs/:port', async (req, res) => {
    const portValue = Number(req.params.port);
    if (!Number.isInteger(portValue) || portValue < scanFrom || portValue >= scanFrom + scanCount) {
        return res.status(400).json({ ok: false, error: 'port out of configured scan range' });
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

app.post('/api/dashboard/lifecycle/:action', async (req, res) => {
    const action = String(req.params.action || '') as DashboardLifecycleAction;
    const portValue = Number(req.body?.port);
    const home = typeof req.body?.home === 'string' ? req.body.home : undefined;
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({
            ok: false,
            action,
            port: portValue,
            status: 'rejected',
            message: `Unsupported lifecycle action: ${action}`,
            home: null,
            pid: null,
            command: [],
        });
    }
    if (!Number.isInteger(portValue)) {
        return res.status(400).json({
            ok: false,
            action,
            port: portValue,
            status: 'rejected',
            message: 'port must be an integer',
            home: null,
            pid: null,
            command: [],
        });
    }

    try {
        const result = action === 'start'
            ? await lifecycle.start(portValue, home)
            : action === 'stop'
                ? await lifecycle.stop(portValue)
                : await lifecycle.restart(portValue);
        observability.publish({
            kind: 'lifecycle-result',
            port: portValue,
            action,
            status: result.status,
            message: result.message,
            at: new Date().toISOString(),
        });
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

const distRoot = join(projectRoot, 'public', 'dist');
const sourceRoot = join(projectRoot, 'public');
const managerHtmlCandidates = [
    join(distRoot, 'manager', 'index.html'),
    join(distRoot, 'public', 'manager', 'index.html'),
    join(distRoot, 'manager.html'),
    join(sourceRoot, 'manager', 'index.html'),
];

function sendManagerHtml(res: express.Response, htmlPath: string): void {
    res.sendFile(basename(htmlPath), { root: dirname(htmlPath) }, error => {
        if (!error || res.headersSent) return;

        console.error(`[dashboard] failed to serve manager html: ${error.message}`);
        res.status(500).send('manager dashboard failed to load');
    });
}

app.use('/dist', express.static(distRoot));
app.use('/assets', express.static(join(distRoot, 'assets')));
app.use('/icons', express.static(join(sourceRoot, 'icons')));
app.use('/manager', express.static(join(sourceRoot, 'manager')));

app.get('/.well-known/appspecific/com.chrome.devtools.json', (_req, res) => {
    res.status(204).end();
});

app.get('/favicon.ico', (_req, res) => {
    res.sendFile('icon-192.png', { root: join(sourceRoot, 'icons') }, error => {
        if (!error || res.headersSent) return;
        res.status(204).end();
    });
});

app.get('/{*splat}', (_req, res) => {
    const htmlPath = managerHtmlCandidates.find(candidate => existsSync(candidate));
    if (!htmlPath) {
        return res.status(500).send('manager dashboard has not been built');
    }
    sendManagerHtml(res, htmlPath);
});

const server = http.createServer(app);
installDashboardProxy(app, server, { from: scanFrom, count: scanCount });

server.on('error', (error: NodeJS.ErrnoException) => {
    void previewProxy.close();
    if (error.code === 'EADDRINUSE') {
        console.error(`[dashboard] port ${port} already in use`);
    } else {
        console.error(`[dashboard] listen error: ${error.message}`);
    }
    process.exit(1);
});

const shutdown = createDashboardShutdown({
    lifecycle,
    previewProxy,
    server,
    exit: code => process.exit(code),
});

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

async function main(): Promise<void> {
    previewProxy.validate();
    server.listen(port, '127.0.0.1', () => {
        const url = `http://localhost:${port}`;
        console.log(`\n  Jaw Manager — ${url}`);
        console.log(`  Scanning: ${scanFrom}-${scanFrom + scanCount - 1}`);
        console.log(`  Preview: ${previewFrom}-${previewFrom + scanCount - 1}\n`);

        if (process.env.JAW_DASHBOARD_OPEN === '1') {
            const openCmd = process.platform === 'darwin' ? 'open'
                : process.platform === 'win32' ? 'cmd'
                    : 'xdg-open';
            const openArgs = process.platform === 'win32'
                ? ['/c', 'start', '', url]
                : [url];
            const opener = spawn(openCmd, openArgs, { detached: true, stdio: 'ignore' });
            opener.unref();
        }
    });
}

void main().catch(async (error: Error) => {
    await previewProxy.close();
    console.error(`[dashboard] startup failed: ${error.message}`);
    process.exit(1);
});
