import { CLI_KEYS } from './registry.js';
import { runCliStatusWorker } from './cli-status-worker.js';

export type CliStatusProbeState = 'checking' | 'fresh' | 'stale';

export interface CliStatusRow {
    available: boolean | null;
    binaryInstalled: boolean | null;
    capabilityReady: boolean | null;
    authenticated: boolean | null;
    path: string | null;
    source: string;
    probeState: CliStatusProbeState;
    reason?: string;
}

export type CliStatusSnapshot = Record<string, CliStatusRow>;

export function formatCliStatusLine(cli: string, row: Pick<CliStatusRow, 'available' | 'capabilityReady' | 'probeState' | 'path'>): string {
    if (row.probeState === 'checking') return `${cli}: checking`;
    const ready = row.available === true && row.capabilityReady !== false;
    return `${cli}: ${ready ? '✅' : '❌'}${row.path ? ` ${row.path}` : ''}`;
}

export interface CliStatusCacheOptions {
    now?: () => number;
    refresh?: () => Promise<CliStatusSnapshot>;
    freshTtlMs?: number;
    staleTtlMs?: number;
}

const FRESH_TTL_MS = 30_000;
const STALE_TTL_MS = 5 * 60_000;

function coldSnapshot(): CliStatusSnapshot {
    return Object.fromEntries(CLI_KEYS.map((cli) => [cli, {
        available: null,
        binaryInstalled: null,
        capabilityReady: null,
        authenticated: null,
        path: null,
        source: 'pending-probe',
        probeState: 'checking' as const,
    }])) as CliStatusSnapshot;
}

function snapshotWithState(snapshot: CliStatusSnapshot, probeState: CliStatusProbeState): CliStatusSnapshot {
    return Object.fromEntries(Object.entries(snapshot).map(([cli, row]) => [cli, {
        ...row,
        probeState,
    }])) as CliStatusSnapshot;
}

export class CliStatusCache {
    private readonly now: () => number;
    private readonly refresh: () => Promise<CliStatusSnapshot>;
    private readonly freshTtlMs: number;
    private readonly staleTtlMs: number;
    private lastSuccessfulSnapshot: CliStatusSnapshot | null = null;
    private lastSuccessfulProbeAt: number | null = null;
    private refreshInFlight: Promise<void> | null = null;

    constructor(options: CliStatusCacheOptions = {}) {
        this.now = options.now ?? Date.now;
        this.refresh = options.refresh ?? runCliStatusWorker;
        this.freshTtlMs = options.freshTtlMs ?? FRESH_TTL_MS;
        this.staleTtlMs = options.staleTtlMs ?? STALE_TTL_MS;
    }

    getSnapshot(): CliStatusSnapshot {
        const now = this.now();
        const age = this.lastSuccessfulProbeAt == null
            ? Number.POSITIVE_INFINITY
            : now - this.lastSuccessfulProbeAt;

        if (this.lastSuccessfulSnapshot && age <= this.freshTtlMs) {
            return snapshotWithState(this.lastSuccessfulSnapshot, 'fresh');
        }

        this.startRefresh();
        if (this.lastSuccessfulSnapshot && age <= this.staleTtlMs) {
            return snapshotWithState(this.lastSuccessfulSnapshot, 'stale');
        }
        return coldSnapshot();
    }

    private startRefresh(): void {
        if (this.refreshInFlight) return;
        this.refreshInFlight = Promise.resolve()
            .then(() => this.refresh())
            .then((snapshot) => {
                this.lastSuccessfulSnapshot = snapshotWithState(snapshot, 'fresh');
                this.lastSuccessfulProbeAt = this.now();
            })
            .catch(() => {
                // Preserve the last successful snapshot/timestamp. A later request retries.
            })
            .finally(() => {
                this.refreshInFlight = null;
            });
    }
}

const defaultCliStatusCache = new CliStatusCache();

export function getCachedCliStatus(): CliStatusSnapshot {
    return defaultCliStatusCache.getSnapshot();
}

/** @internal exported for deterministic cache tests. */
export function createCliStatusCacheForTest(options: CliStatusCacheOptions): CliStatusCache {
    return new CliStatusCache(options);
}
