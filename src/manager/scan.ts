import {
    DASHBOARD_DEFAULT_PORT,
    DASHBOARD_FALLBACK_PORT_START,
    DASHBOARD_FALLBACK_PORT_END,
    DASHBOARD_SCAN_TIMEOUT_MS,
    MANAGED_INSTANCE_HOST,
    MANAGED_INSTANCE_PORT_COUNT,
    MANAGED_INSTANCE_PORT_FROM,
} from './constants.js';
import { internalFetch } from './internal-fetch.js';
import { deriveDashboardInstanceId, normalizeSettingsMetadata } from './metadata.js';
import { deriveProfiles } from './profiles.js';
import {
    assertRangeDoesNotContainPort,
    parsePositiveCount,
    parsePositivePort,
    toPortRange,
} from './security.js';
import type {
    DashboardInstance,
    DashboardScanOptions,
    DashboardScanResult,
    DashboardInstanceStatus,
    FetchLike,
} from './types.js';

type JsonRecord = Record<string, unknown>;

function scanRange(options: DashboardScanOptions): { from: number; count: number; to: number } {
    const from = parsePositivePort(options.from, MANAGED_INSTANCE_PORT_FROM);
    const count = parsePositiveCount(options.count, MANAGED_INSTANCE_PORT_COUNT, MANAGED_INSTANCE_PORT_COUNT);
    return { from, count, to: from + count - 1 };
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'TimeoutError'
        || error instanceof Error && error.name === 'AbortError';
}

async function readJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<JsonRecord> {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const body = await response.json() as unknown;
    return body && typeof body === 'object' ? body as JsonRecord : {};
}

function readNumber(body: JsonRecord, key: string): number | null {
    const value = body[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(body: JsonRecord, key: string): string | null {
    const value = body[key];
    return typeof value === 'string' && value.trim() ? value : null;
}

function buildBaseRow(port: number, status: DashboardInstanceStatus, checkedAt: string, reason: string | null): DashboardInstance {
    return {
        port,
        url: `http://localhost:${port}`,
        status,
        ok: status === 'online',
        version: null,
        uptime: null,
        instanceId: null,
        homeDisplay: null,
        workingDir: null,
        projectDirs: null,
        currentCli: null,
        currentModel: null,
        serviceMode: 'unknown',
        lastCheckedAt: checkedAt,
        healthReason: reason,
    };
}

export async function scanPort(port: number, fetchImpl: FetchLike, timeoutMs: number, checkedAt: string): Promise<DashboardInstance> {
    const baseUrl = `http://${MANAGED_INSTANCE_HOST}:${port}`;
    try {
        const health = await readJson(fetchImpl, `${baseUrl}/api/health`, timeoutMs);
        const row = buildBaseRow(port, 'online', checkedAt, null);
        row.version = readString(health, 'version');
        row.uptime = readNumber(health, 'uptime');

        try {
            const settings = await readJson(fetchImpl, `${baseUrl}/api/settings`, timeoutMs);
            const metadata = normalizeSettingsMetadata(settings);
            row.homeDisplay = metadata.homeDisplay;
            row.workingDir = metadata.workingDir;
            row.projectDirs = metadata.projectDirs;
            row.currentCli = metadata.currentCli;
            row.currentModel = metadata.currentModel;
            row.multiSession = metadata.multiSession;
            row.instanceId = deriveDashboardInstanceId(metadata.homeDisplay);
        } catch (error) {
            row.healthReason = `metadata unavailable: ${(error as Error).message}`;
        }

        try {
            const runtime = await readJson(fetchImpl, `${baseUrl}/api/runtime`, timeoutMs);
            const data = runtime["data"] && typeof runtime["data"] === 'object'
                ? runtime["data"] as JsonRecord
                : runtime;
            row.currentCli ||= readString(data, 'cli');
            row.currentModel ||= readString(data, 'model');
        } catch {
            // Runtime is optional for phase 10.2; health/settings still identify the row.
        }

        return row;
    } catch (error) {
        const status: DashboardInstanceStatus = isAbortError(error) ? 'timeout' : 'offline';
        return buildBaseRow(port, status, checkedAt, (error as Error).message || status);
    }
}

export async function scanSinglePort(port: number, options: DashboardScanOptions = {}): Promise<DashboardInstance> {
    const checkedAt = new Date().toISOString();
    const timeoutMs = parsePositivePort(options.timeoutMs, DASHBOARD_SCAN_TIMEOUT_MS);
    const fetchImpl = options.fetchImpl || internalFetch;
    return scanPort(port, fetchImpl, timeoutMs, checkedAt);
}

export async function scanDashboardInstances(options: DashboardScanOptions = {}): Promise<DashboardScanResult> {
    const { from, count, to } = scanRange(options);
    const checkedAt = new Date().toISOString();
    const timeoutMs = parsePositivePort(options.timeoutMs, DASHBOARD_SCAN_TIMEOUT_MS);
    const fetchImpl = options.fetchImpl || internalFetch;
    const managerPort = parsePositivePort(options.managerPort, Number(DASHBOARD_DEFAULT_PORT));
    assertRangeDoesNotContainPort(toPortRange(from, count), managerPort, 'scan range');
    const ports = Array.from({ length: count }, (_, index) => from + index);

    const scanned = await Promise.all(
        ports.map(port => scanPort(port, fetchImpl, timeoutMs, checkedAt))
    );
    const { instances, profiles } = deriveProfiles(scanned);

    return {
        manager: {
            port: managerPort,
            rangeFrom: from,
            rangeTo: to,
            checkedAt,
            proxy: {
                enabled: true,
                basePath: '/i',
                allowedFrom: from,
                allowedTo: to,
            },
            profiles,
        },
        instances,
    };
}

export async function scanPeerDashboards(managerPort: number, options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<DashboardInstance[]> {
    const checkedAt = new Date().toISOString();
    const timeoutMs = options.timeoutMs || DASHBOARD_SCAN_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl || internalFetch;
    const dashDefault = Number(DASHBOARD_DEFAULT_PORT);
    const ports = [dashDefault];
    for (let p = DASHBOARD_FALLBACK_PORT_START; p <= DASHBOARD_FALLBACK_PORT_END; p++) {
        ports.push(p);
    }
    const peers: DashboardInstance[] = [];
    for (const port of ports) {
        if (port === managerPort) continue;
        const baseUrl = `http://${MANAGED_INSTANCE_HOST}:${port}`;
        try {
            const health = await readJson(fetchImpl, `${baseUrl}/api/dashboard/health`, timeoutMs);
            if (health["service"] !== 'manager-dashboard') continue;
            const row = buildBaseRow(port, 'online', checkedAt, null);
            row.version = readString(health, 'version');
            row.uptime = readNumber(health, 'uptime');
            try {
                const settings = await readJson(fetchImpl, `${baseUrl}/api/settings`, timeoutMs);
                const metadata = normalizeSettingsMetadata(settings);
                row.homeDisplay = metadata.homeDisplay;
                row.workingDir = metadata.workingDir;
                row.instanceId = deriveDashboardInstanceId(metadata.homeDisplay);
            } catch { /* metadata optional */ }
            peers.push(row);
        } catch { /* not running or not a dashboard */ }
    }
    return peers;
}
