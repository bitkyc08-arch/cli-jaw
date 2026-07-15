import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import {
    isElectronRenderer,
    requireElectronRenderer,
} from '../electron-renderer-identity.js';

export { CLI_JAW_ELECTRON_HEADER } from '../electron-renderer-identity.js';
export const ELECTRON_METRICS_TTL_MS = 30_000;

export interface MetricsProcessSample {
    type: string;
    name?: string;
    pid: number;
    rssKb: number;
    cpu: number;
}

export interface MetricsSnapshot {
    ts: number;
    rendererCount: number;
    mainCount: number;
    rssTotalKb: number;
    processes: MetricsProcessSample[];
}

interface StoredEntry {
    snapshot: MetricsSnapshot;
    receivedAt: number;
}

export type GetMetricsResponse =
    | { available: false; reason: 'not-in-electron' }
    | { available: true; snapshot: MetricsSnapshot | null };

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

function isOptionalString(v: unknown): v is string | undefined {
    return v === undefined || typeof v === 'string';
}

function validateProcess(p: unknown): MetricsProcessSample | null {
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    if (typeof o["type"] !== 'string') return null;
    if (!isOptionalString(o["name"])) return null;
    if (!isFiniteNumber(o["pid"])) return null;
    if (!isFiniteNumber(o["rssKb"])) return null;
    if (!isFiniteNumber(o["cpu"])) return null;
    const sample: MetricsProcessSample = {
        type: o["type"],
        pid: o["pid"],
        rssKb: o["rssKb"],
        cpu: o["cpu"],
    };
    if (typeof o["name"] === 'string') sample.name = o["name"];
    return sample;
}

export function validateMetricsSnapshot(body: unknown): MetricsSnapshot | null {
    if (!body || typeof body !== 'object') return null;
    const o = body as Record<string, unknown>;
    if (!isFiniteNumber(o["ts"])) return null;
    if (!isFiniteNumber(o["rendererCount"])) return null;
    if (!isFiniteNumber(o["mainCount"])) return null;
    if (!isFiniteNumber(o["rssTotalKb"])) return null;
    if (!Array.isArray(o["processes"])) return null;
    if (o["processes"].length > 256) return null;
    const processes: MetricsProcessSample[] = [];
    for (const raw of o["processes"]) {
        const sample = validateProcess(raw);
        if (!sample) return null;
        processes.push(sample);
    }
    return {
        ts: o["ts"],
        rendererCount: o["rendererCount"],
        mainCount: o["mainCount"],
        rssTotalKb: o["rssTotalKb"],
        processes,
    };
}

export interface ElectronMetricsStore {
    get(key: string, now?: number): MetricsSnapshot | null;
    set(key: string, snapshot: MetricsSnapshot, now?: number): void;
    delete(key: string): void;
    size(): number;
}

export function createElectronMetricsStore(
    ttlMs: number = ELECTRON_METRICS_TTL_MS,
): ElectronMetricsStore {
    const map = new Map<string, StoredEntry>();
    return {
        get(key, now = Date.now()) {
            const entry = map.get(key);
            if (!entry) return null;
            if (now - entry.receivedAt > ttlMs) {
                map.delete(key);
                return null;
            }
            return entry.snapshot;
        },
        set(key, snapshot, now = Date.now()) {
            map.set(key, { snapshot, receivedAt: now });
        },
        delete(key) {
            map.delete(key);
        },
        size() {
            return map.size;
        },
    };
}

const globalStore = createElectronMetricsStore();

function clientKey(req: Request): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

export interface CreateElectronMetricsRouterOptions {
    store?: ElectronMetricsStore;
}

export function createElectronMetricsRouter(
    options: CreateElectronMetricsRouterOptions = {},
): Router {
    const store = options.store ?? globalStore;
    const router = createRouter();

    router.get('/', (req: Request, res: Response<GetMetricsResponse>) => {
        if (!isElectronRenderer(req)) {
            res.json({ available: false, reason: 'not-in-electron' });
            return;
        }
        const snapshot = store.get(clientKey(req));
        res.json({ available: true, snapshot });
    });

    router.post('/', requireElectronRenderer, (req: Request, res: Response) => {
        const snapshot = validateMetricsSnapshot(req.body);
        if (!snapshot) {
            res.status(400).json({ error: 'invalid-body' });
            return;
        }
        store.set(clientKey(req), snapshot);
        res.json({ ok: true });
    });

    return router;
}
