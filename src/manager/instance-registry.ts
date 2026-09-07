// ─── Instance Registry (cached background scan) ──────
// Phase 4a of runtime SSE refactoring.
// Replaces per-request full scans (50 ports × 3 endpoints = 150 loopback
// fetches) with one background scan every 10s + an in-memory snapshot.
// Status changes are published to the event-bus 'worker' topic — here
// 'worker' means managed cli-jaw instances (09 §2 P1 semantics), NOT
// employee/worker agents.

import { publish } from '../core/event-bus.js';
import type { DashboardInstance, DashboardScanResult } from './types.js';

export const DEFAULT_SCAN_INTERVAL_MS = 10_000;

export interface InstanceDiff {
    port: number;
    change: 'appeared' | 'disappeared' | 'status' | 'version';
    prev?: { status: string; version: string | null };
    next?: { status: string; version: string | null };
}

export interface InstanceRegistryDeps {
    scan: () => Promise<DashboardScanResult>;
    /** Side effects that previously ran per request (recordScanEvents,
     *  previewProxy.reconcileOnlineTargets). Errors are caught and logged. */
    onScanResult?: (result: DashboardScanResult) => void | Promise<void>;
}

export function computeDiffs(
    prev: Map<number, DashboardInstance>,
    next: DashboardInstance[],
): InstanceDiff[] {
    const diffs: InstanceDiff[] = [];
    const nextMap = new Map(next.map(n => [n.port, n]));

    for (const [port, old] of prev) {
        const cur = nextMap.get(port);
        if (!cur) {
            diffs.push({ port, change: 'disappeared', prev: { status: old.status, version: old.version ?? null } });
        } else if (old.status !== cur.status) {
            diffs.push({
                port, change: 'status',
                prev: { status: old.status, version: old.version ?? null },
                next: { status: cur.status, version: cur.version ?? null },
            });
        } else if ((old.version ?? null) !== (cur.version ?? null)) {
            diffs.push({
                port, change: 'version',
                prev: { status: old.status, version: old.version ?? null },
                next: { status: cur.status, version: cur.version ?? null },
            });
        }
    }
    for (const [port, cur] of nextMap) {
        if (!prev.has(port)) {
            diffs.push({ port, change: 'appeared', next: { status: cur.status, version: cur.version ?? null } });
        }
    }
    return diffs;
}

export class InstanceRegistry {
    private deps: InstanceRegistryDeps;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastResult: DashboardScanResult | null = null;
    private byPort = new Map<number, DashboardInstance>();
    private inFlight: Promise<DashboardScanResult> | null = null;

    constructor(deps: InstanceRegistryDeps) {
        this.deps = deps;
    }

    start(intervalMs: number = DEFAULT_SCAN_INTERVAL_MS): void {
        if (this.timer) return;
        void this.forceRefresh().catch(() => { /* logged in refresh */ });
        this.timer = setInterval(() => {
            void this.forceRefresh().catch(() => { /* logged in refresh */ });
        }, intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    isReady(): boolean { return this.lastResult !== null; }

    /** Last raw scan result (pre-decoration). Null until the first scan lands. */
    snapshot(): DashboardScanResult | null { return this.lastResult; }

    /** Run a scan now. Concurrent callers share one in-flight scan.
     *  On failure the previous snapshot is kept and the error rethrown. */
    forceRefresh(): Promise<DashboardScanResult> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = (async () => {
            try {
                const result = await this.deps.scan();
                const diffs = computeDiffs(this.byPort, result.instances);
                this.lastResult = result;
                this.byPort = new Map(result.instances.map(i => [i.port, i]));
                for (const diff of diffs) {
                    publish('worker', 'instance-status-changed', { ...diff });
                }
                if (this.deps.onScanResult) {
                    try {
                        await this.deps.onScanResult(result);
                    } catch (err) {
                        console.error('[instance-registry] onScanResult failed:', (err as Error).message);
                    }
                }
                return result;
            } catch (err) {
                console.error('[instance-registry] scan failed:', (err as Error).message);
                throw err;
            } finally {
                this.inFlight = null;
            }
        })();
        return this.inFlight;
    }
}
