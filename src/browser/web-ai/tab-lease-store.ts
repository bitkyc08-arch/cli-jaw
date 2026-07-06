import { existsSync, mkdirSync, openSync, readFileSync, closeSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { JAW_HOME } from '../../core/config.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import { closeTab, listTabs } from '../connection.js';
import type { WebAiVendor } from './types.js';

export type TabLeaseState = 'active-session' | 'pooled' | 'completed-session' | 'closing' | 'closed';

export interface TabLease {
    owner: 'cli-jaw' | 'web-ai' | string;
    vendor: WebAiVendor;
    sessionType: string;
    origin: string;
    browserProfileKey: string;
    targetId: string;
    sessionId?: string | null;
    url?: string | null;
    state: TabLeaseState;
    leasedAt: string;
    pooledAt?: string | null;
    finalizedAt?: string | null;
    poolExpiresAt?: string | null;
    leaseDisposition?: string | null;
    closePreviousState?: TabLeaseState | null;
    updatedAt: string;
    leaseKey: string;
    // 8.11 (catalog 106): owner process for active-session leases; a lease whose owner
    // process is gone is reclaimable (orphaned tab) on cleanup.
    ownerPid?: number | null;
}

export interface LeaseScopeInput {
    owner?: string;
    vendor: WebAiVendor;
    sessionType?: string;
    url?: string | null;
    origin?: string | null;
    browserProfileKey?: string;
    port?: number;
}

export interface ReleaseLeaseInput extends LeaseScopeInput {
    targetId: string | null | undefined;
    sessionId?: string | null;
    url?: string | null;
    completedAt?: string;
    // 8.11: active-session lease owner + per-call active capacity overrides.
    ownerPid?: number | null;
    activeMaxPerKey?: number;
    activeGlobalMax?: number;
}

export interface CheckoutLeaseInput extends LeaseScopeInput {
    port: number;
}

const STORE_FILE = join(JAW_HOME, 'browser-web-ai-tab-leases.json');
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_POOL_TTL_MS = 15 * 60 * 1000;
const DEFAULT_POOL_MAX_PER_KEY = 3;
const DEFAULT_POOL_GLOBAL_MAX = 8;
// 8.11 (catalog 106): active-session capacity caps (per leaseKey and global per owner+profile).
const DEFAULT_ACTIVE_MAX_PER_KEY = 5;
const DEFAULT_ACTIVE_GLOBAL_MAX = 14;

interface LeaseStoreFile {
    version: 1;
    leases: TabLease[];
}

interface ClosePlanItem {
    lease: TabLease;
    reason: 'expired' | 'overflow' | 'closed' | 'owner-pid-dead';
}

/** Thrown when recording a new active lease would exceed the provider active-tab caps. */
export class ProviderActiveCapacityError extends Error {
    errorCode = 'provider.active-capacity';
    stage = 'provider-capacity';
    retryHint = 'wait-or-retry-later';
    mutationAllowed = false;
    evidence: { reason: string; limit: number; current: number; leaseKey: string; vendor: string; browserProfileKey: string };
    constructor(details: { reason: string; limit: number; current: number; leaseKey: string; vendor: string; browserProfileKey: string }) {
        super(`provider active tab capacity exceeded: ${details.reason} ${details.current}/${details.limit}`);
        this.name = 'ProviderActiveCapacityError';
        this.evidence = details;
    }
}

function storePath(): string {
    return STORE_FILE;
}

function lockPath(): string {
    return `${storePath()}.lock`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function hasErrorCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export function parseDuration(value: string | number | null | undefined, fallbackMs = DEFAULT_POOL_TTL_MS): number {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    const raw = String(value || '').trim();
    if (!raw) return fallbackMs;
    const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(raw);
    if (!match) return fallbackMs;
    const n = Number(match[1]);
    const unit = (match[2] || 'ms').toLowerCase();
    if (unit === 'h') return n * 3_600_000;
    if (unit === 'm') return n * 60_000;
    if (unit === 's') return n * 1000;
    return n;
}

function poolTtlMs(): number {
    return parseDuration(process.env["JAW_BROWSER_PROVIDER_POOL_TTL"] || process.env["AGBROWSE_PROVIDER_POOL_TTL"] || '15m');
}

function poolMaxPerKey(): number {
    const parsed = Number(process.env["JAW_BROWSER_PROVIDER_POOL_MAX_PER_KEY"] || process.env["AGBROWSE_PROVIDER_POOL_MAX_PER_KEY"] || DEFAULT_POOL_MAX_PER_KEY);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_POOL_MAX_PER_KEY;
}

function poolGlobalMax(): number {
    const parsed = Number(process.env["JAW_BROWSER_PROVIDER_POOL_GLOBAL_MAX"] || process.env["AGBROWSE_PROVIDER_POOL_GLOBAL_MAX"] || DEFAULT_POOL_GLOBAL_MAX);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_POOL_GLOBAL_MAX;
}

function activeMaxPerKey(): number {
    const parsed = Number(process.env["JAW_BROWSER_PROVIDER_ACTIVE_MAX_PER_KEY"] || process.env["AGBROWSE_PROVIDER_ACTIVE_MAX_PER_KEY"] || DEFAULT_ACTIVE_MAX_PER_KEY);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_ACTIVE_MAX_PER_KEY;
}

function activeGlobalMax(): number {
    const parsed = Number(process.env["JAW_BROWSER_PROVIDER_ACTIVE_GLOBAL_MAX"] || process.env["AGBROWSE_PROVIDER_ACTIVE_GLOBAL_MAX"] || DEFAULT_ACTIVE_GLOBAL_MAX);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_ACTIVE_GLOBAL_MAX;
}

/**
 * 8.11: a lease is reclaimable when it is an active-session lease whose owner process
 * is gone. A missing/non-positive ownerPid is never treated as dead (legacy-safe).
 */
export function isDeadOwnerActiveLease(
    lease: Pick<TabLease, 'state' | 'ownerPid'>,
    alive: (pid: number) => boolean,
): boolean {
    return lease.state === 'active-session'
        && typeof lease.ownerPid === 'number'
        && lease.ownerPid > 0
        && Number.isFinite(lease.ownerPid)
        && !alive(lease.ownerPid);
}

/** True if the process is alive (or exists but not ours: EPERM). Mirrors watcher-lock. */
function pidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as { code?: string })?.code === 'EPERM';
    }
}

/**
 * Normalize a capacity limit, faithful to agbrowse tab-lease-store.mjs:normalizeLimit:
 * non-finite → -1 (the `>= 0` guards disable that check); finite → clamped to >= 0
 * (so a negative cap becomes 0 = block-all, not "unlimited"). Mirrors the source exactly.
 */
function normalizeLimit(value: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return -1;
    return Math.max(0, Math.floor(parsed));
}

/**
 * 8.11: enforce active-session capacity (per leaseKey, then global per owner+profile).
 * Throws ProviderActiveCapacityError when the next lease would exceed a configured cap.
 */
export function assertActiveCapacity(
    retained: TabLease[],
    nextLease: TabLease,
    limits: { maxPerKey: number; globalMax: number },
): void {
    const active = retained.filter(lease =>
        lease.state === 'active-session' &&
        lease.owner === nextLease.owner &&
        lease.browserProfileKey === nextLease.browserProfileKey &&
        !isDeadOwnerActiveLease(lease, pidAlive),
    );
    const maxPerKey = normalizeLimit(limits.maxPerKey);
    if (maxPerKey >= 0) {
        const perKeyCount = active.filter(lease => lease.leaseKey === nextLease.leaseKey).length;
        if (perKeyCount >= maxPerKey) {
            throw new ProviderActiveCapacityError({
                reason: 'active-max-per-key',
                limit: maxPerKey,
                current: perKeyCount,
                leaseKey: nextLease.leaseKey,
                vendor: nextLease.vendor,
                browserProfileKey: nextLease.browserProfileKey,
            });
        }
    }
    const globalMax = normalizeLimit(limits.globalMax);
    if (globalMax >= 0 && active.length >= globalMax) {
        throw new ProviderActiveCapacityError({
            reason: 'active-global-max',
            limit: globalMax,
            current: active.length,
            leaseKey: nextLease.leaseKey,
            vendor: nextLease.vendor,
            browserProfileKey: nextLease.browserProfileKey,
        });
    }
}

export function originFromUrl(url: string | null | undefined, fallback = 'unknown-origin'): string {
    if (!url) return fallback;
    try {
        return new URL(url).origin;
    } catch {
        return fallback;
    }
}

export function buildLeaseKey(input: LeaseScopeInput): string {
    const owner = input.owner || 'cli-jaw';
    const sessionType = input.sessionType || 'jaw';
    const origin = input.origin || originFromUrl(input.url, 'unknown-origin');
    const browserProfileKey = input.browserProfileKey || `cdp:${input.port || 'default'}`;
    return `${owner}:${input.vendor}:${sessionType}:${origin}:${browserProfileKey}`;
}

function normalizeLease(raw: Partial<TabLease>): TabLease | null {
    if (!raw.targetId || !raw.vendor) return null;
    const url = raw.url || null;
    const owner = raw.owner || 'cli-jaw';
    const sessionType = raw.sessionType || 'jaw';
    const origin = raw.origin || originFromUrl(url, 'unknown-origin');
    const browserProfileKey = raw.browserProfileKey || 'cdp:default';
    const leaseKey = raw.leaseKey || buildLeaseKey({ owner, vendor: raw.vendor, sessionType, origin, browserProfileKey });
    return {
        owner,
        vendor: raw.vendor,
        sessionType,
        origin,
        browserProfileKey,
        targetId: raw.targetId,
        sessionId: raw.sessionId || null,
        url,
        state: raw.state || 'pooled',
        leasedAt: raw.leasedAt || raw.updatedAt || nowIso(),
        pooledAt: raw.pooledAt || null,
        finalizedAt: raw.finalizedAt || null,
        poolExpiresAt: raw.poolExpiresAt || null,
        leaseDisposition: raw.leaseDisposition || null,
        closePreviousState: raw.closePreviousState || null,
        updatedAt: raw.updatedAt || nowIso(),
        leaseKey,
        // Preserve a stored owner pid; missing → null (not stamped, so legacy leases
        // are never mistaken for dead-owned and reclaimed).
        ownerPid: typeof raw.ownerPid === 'number' ? raw.ownerPid : null,
    };
}

function readStoreUnlocked(): LeaseStoreFile {
    if (!existsSync(storePath())) return { version: 1, leases: [] };
    try {
        const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as Partial<LeaseStoreFile>;
        return {
            version: 1,
            leases: Array.isArray(parsed.leases)
                ? parsed.leases.map(normalizeLease).filter((lease): lease is TabLease => Boolean(lease))
                : [],
        };
    } catch {
        return { version: 1, leases: [] };
    }
}

function writeStoreUnlocked(store: LeaseStoreFile): void {
    mkdirSync(dirname(storePath()), { recursive: true });
    const tmp = `${storePath()}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, leases: store.leases }, null, 2)}\n`);
    renameSync(tmp, storePath());
}

export async function withLeaseLock<T>(fn: () => T | Promise<T>): Promise<T> {
    mkdirSync(dirname(lockPath()), { recursive: true });
    const startedAt = Date.now();
    let fd: number | null = null;
    while (fd === null) {
        try {
            fd = openSync(lockPath(), 'wx');
        } catch (error: unknown) {
            if (!hasErrorCode(error, 'EEXIST')) throw error;
            try {
                const raw = readFileSync(lockPath(), 'utf8');
                const lockedAt = Number(JSON.parse(raw).lockedAt || 0);
                if (lockedAt && Date.now() - lockedAt > LOCK_STALE_MS) unlinkSync(lockPath());
            } catch {
                try {
                    unlinkSync(lockPath());
                } catch {
                    // Another process may have removed it.
                }
            }
            if (Date.now() - startedAt > LOCK_TIMEOUT_MS) throw new Error('Timed out waiting for browser web-ai tab lease lock');
            await sleep(LOCK_RETRY_MS);
        }
    }
    try {
        writeFileSync(fd, JSON.stringify({ lockedAt: Date.now(), pid: process.pid }));
        return await fn();
    } finally {
        closeSync(fd);
        try {
            unlinkSync(lockPath());
        } catch {
            // Another stale-lock cleanup may have raced with us.
        }
    }
}

export async function listLeases(): Promise<TabLease[]> {
    return withLeaseLock(() => readStoreUnlocked().leases);
}

export async function recordActiveLease(input: ReleaseLeaseInput): Promise<TabLease | null> {
    if (!input.targetId) return null;
    return withLeaseLock(() => {
        const store = readStoreUnlocked();
        const now = nowIso();
        const leaseKey = buildLeaseKey(input);
        const lease: TabLease = {
            owner: input.owner || 'cli-jaw',
            vendor: input.vendor,
            sessionType: input.sessionType || 'jaw',
            origin: input.origin || originFromUrl(input.url, 'unknown-origin'),
            browserProfileKey: input.browserProfileKey || `cdp:${input.port || 'default'}`,
            targetId: input.targetId!,
            sessionId: input.sessionId || null,
            url: input.url || null,
            state: 'active-session',
            leasedAt: now,
            pooledAt: null,
            finalizedAt: null,
            poolExpiresAt: null,
            leaseDisposition: null,
            updatedAt: now,
            leaseKey,
            ownerPid: input.ownerPid === null ? null : Number(input.ownerPid ?? process.pid),
        };
        const retained = store.leases.filter(existing => !sameTargetScope(existing, lease) && !sameSessionScope(existing, lease));
        // 8.11: cap active leases (per key, then global per owner+profile) before recording.
        assertActiveCapacity(retained, lease, {
            maxPerKey: input.activeMaxPerKey ?? activeMaxPerKey(),
            globalMax: input.activeGlobalMax ?? activeGlobalMax(),
        });
        retained.push(lease);
        store.leases = retained;
        writeStoreUnlocked(store);
        return lease;
    });
}

function selectPoolClosePlan(leases: TabLease[], timestamp = Date.now()): ClosePlanItem[] {
    const closePlan: ClosePlanItem[] = [];
    const pooled = leases.filter(lease => lease.state === 'pooled');
    for (const lease of pooled) {
        const expiresAt = lease.poolExpiresAt ? Date.parse(lease.poolExpiresAt) : Number.NaN;
        if (Number.isFinite(expiresAt) && expiresAt <= timestamp) closePlan.push({ lease, reason: 'expired' });
    }
    const expiredIds = new Set(closePlan.map(item => item.lease.targetId));
    const byKey = new Map<string, TabLease[]>();
    for (const lease of pooled.filter(lease => !expiredIds.has(lease.targetId))) {
        const list = byKey.get(lease.leaseKey) || [];
        list.push(lease);
        byKey.set(lease.leaseKey, list);
    }
    const maxPerKey = poolMaxPerKey();
    for (const list of byKey.values()) {
        const sorted = list.slice().sort((a, b) => Date.parse(b.pooledAt || b.updatedAt) - Date.parse(a.pooledAt || a.updatedAt));
        for (const lease of sorted.slice(maxPerKey)) closePlan.push({ lease, reason: 'overflow' });
    }
    const kept = pooled.filter(lease => !closePlan.some(item => item.lease.targetId === lease.targetId));
    const globalMax = poolGlobalMax();
    if (kept.length > globalMax) {
        const sorted = kept.slice().sort((a, b) => Date.parse(b.pooledAt || b.updatedAt) - Date.parse(a.pooledAt || a.updatedAt));
        for (const lease of sorted.slice(globalMax)) closePlan.push({ lease, reason: 'overflow' });
    }
    return closePlan;
}

function scopedTargetKey(lease: Pick<TabLease, 'owner' | 'vendor' | 'sessionType' | 'origin' | 'browserProfileKey' | 'targetId'>): string {
    return [lease.owner || '', lease.vendor || '', lease.sessionType || '', lease.origin || '', lease.browserProfileKey || '', lease.targetId || ''].join(':');
}

function sameTargetScope(a: TabLease, b: TabLease): boolean {
    return Boolean(a?.targetId && b?.targetId && scopedTargetKey(a) === scopedTargetKey(b));
}

function sameSessionScope(a: TabLease, b: TabLease): boolean {
    return Boolean(a?.sessionId && b?.sessionId && a.sessionId === b.sessionId && a.owner === b.owner && a.vendor === b.vendor && a.sessionType === b.sessionType && a.browserProfileKey === b.browserProfileKey);
}

function sameBrowserProfile(a: TabLease, b: TabLease): boolean {
    return a.owner === b.owner && a.vendor === b.vendor && a.sessionType === b.sessionType && a.browserProfileKey === b.browserProfileKey;
}

async function closePlanned(port: number, plan: ClosePlanItem[]): Promise<ClosePlanItem[]> {
    const closed: ClosePlanItem[] = [];
    const failed: ClosePlanItem[] = [];
    for (const { lease } of plan) {
        try {
            await closeTab(port, lease.targetId);
            closed.push({ lease, reason: 'closed' });
        } catch {
            failed.push({ lease, reason: 'closed' });
        }
    }
    if (closed.length > 0 || failed.length > 0) {
        const closedKeys = new Set(closed.map(item => scopedTargetKey(item.lease)));
        const failedKeys = new Set(failed.map(item => scopedTargetKey(item.lease)));
        await withLeaseLock(() => {
            const store = readStoreUnlocked();
            store.leases = store.leases
                .filter(lease => !closedKeys.has(scopedTargetKey(lease)))
                .map(lease => failedKeys.has(scopedTargetKey(lease))
                    ? { ...lease, state: lease.closePreviousState || 'pooled', closePreviousState: null, leaseDisposition: 'close-failed-retryable', updatedAt: nowIso() }
                    : lease);
            writeStoreUnlocked(store);
        });
    }
    return closed;
}

export async function releaseCompletedLease(input: ReleaseLeaseInput): Promise<TabLease | null> {
    if (!input.targetId) return null;
    const ttlMs = poolTtlMs();
    const maxPerKey = poolMaxPerKey();
    const port = input.port || 0;
    let closePlan: ClosePlanItem[] = [];
    const pooledLease = await withLeaseLock(() => {
        const store = readStoreUnlocked();
        const now = nowIso();
        const pooledAtMs = Date.parse(input.completedAt || now);
        const leaseKey = buildLeaseKey(input);
        const lease: TabLease = {
            owner: input.owner || 'cli-jaw',
            vendor: input.vendor,
            sessionType: input.sessionType || 'jaw',
            origin: input.origin || originFromUrl(input.url, 'unknown-origin'),
            browserProfileKey: input.browserProfileKey || `cdp:${input.port || 'default'}`,
            targetId: input.targetId!,
            sessionId: input.sessionId || null,
            url: input.url || null,
            state: maxPerKey > 0 && ttlMs > 0 ? 'pooled' : 'completed-session',
            leasedAt: now,
            pooledAt: now,
            finalizedAt: now,
            poolExpiresAt: maxPerKey > 0 && ttlMs > 0 ? new Date(pooledAtMs + ttlMs).toISOString() : now,
            leaseDisposition: maxPerKey > 0 && ttlMs > 0 ? 'pooled' : 'close-no-pool-slot',
            updatedAt: now,
            leaseKey,
        };
        const current = store.leases.find(existing => sameTargetScope(existing, lease));
        if (!current || current.state !== 'active-session' || !lease.sessionId || current.sessionId !== lease.sessionId) return lease;
        store.leases = store.leases.filter(existing => !sameTargetScope(existing, lease));
        store.leases.push(lease);
        closePlan = selectPoolClosePlan(store.leases.filter(existing => sameBrowserProfile(existing, lease)));
        if (lease.state === 'completed-session') closePlan.push({ lease: { ...lease, state: 'closing', leaseDisposition: 'closing' }, reason: 'closed' });
        const closingIds = new Set(closePlan.map(item => scopedTargetKey(item.lease)));
        store.leases = store.leases.map(existing => closingIds.has(scopedTargetKey(existing))
            ? { ...existing, state: 'closing', closePreviousState: existing.closePreviousState || existing.state, leaseDisposition: 'closing', updatedAt: now }
            : existing);
        writeStoreUnlocked(store);
        return lease;
    });
    await closePlanned(port, closePlan);
    return pooledLease;
}

export async function checkoutPooledLease(input: CheckoutLeaseInput): Promise<{ targetId: string; url?: string | null } | null> {
    let selected: TabLease | null = null;
    let closePlan: ClosePlanItem[] = [];
    const browserProfileKey = `cdp:${input.port || 'default'}`;
    const liveTargetIds = new Set((await listTabs(input.port)).map(tab => tab.targetId));
    await withLeaseLock(() => {
        const store = readStoreUnlocked();
        const now = Date.now();
        closePlan = selectPoolClosePlan(store.leases.filter(lease => lease.browserProfileKey === browserProfileKey), now);
        const closeIds = new Set(closePlan.map(item => scopedTargetKey(item.lease)));
        const leaseKey = buildLeaseKey(input);
        selected = store.leases
            .filter(lease => lease.browserProfileKey === browserProfileKey && lease.state === 'pooled' && lease.leaseKey === leaseKey && !closeIds.has(scopedTargetKey(lease)))
            .filter(lease => liveTargetIds.has(lease.targetId))
            .sort((a, b) => Date.parse(b.pooledAt || b.updatedAt) - Date.parse(a.pooledAt || a.updatedAt))[0] || null;
        const selectedId = selected?.targetId || null;
        store.leases = store.leases.filter(lease => {
            if (selectedId && sameTargetScope(lease, selected as TabLease)) return false;
            if (closeIds.has(scopedTargetKey(lease))) return true;
            if (lease.browserProfileKey === browserProfileKey && lease.state === 'pooled' && !liveTargetIds.has(lease.targetId)) return false;
            return true;
        }).map(lease => closeIds.has(scopedTargetKey(lease))
            ? { ...lease, state: 'closing', closePreviousState: lease.closePreviousState || lease.state, leaseDisposition: 'closing', updatedAt: nowIso() }
            : lease);
        writeStoreUnlocked(store);
    });
    await closePlanned(input.port, closePlan);
    const checkedOut = selected as TabLease | null;
    return checkedOut ? stripUndefined({ targetId: checkedOut.targetId, url: checkedOut.url }) : null;
}

export async function cleanupLeasedTabs(port: number, opts: { activeCommandTargetIds?: Set<string> } = {}): Promise<{ closed: number; closedTabs: string[] }> {
    const protectedIds = opts.activeCommandTargetIds || new Set<string>();
    let closePlan: ClosePlanItem[] = [];
    await withLeaseLock(() => {
        const store = readStoreUnlocked();
        const browserProfileKey = `cdp:${port || 'default'}`;
        const profileLeases = store.leases.filter(lease => lease.browserProfileKey === browserProfileKey);
        const deadOwner: ClosePlanItem[] = profileLeases
            .filter(lease => isDeadOwnerActiveLease(lease, pidAlive))
            .filter(lease => !protectedIds.has(lease.targetId))
            .map(lease => ({ lease, reason: 'owner-pid-dead' as const }));
        closePlan = [...selectPoolClosePlan(profileLeases), ...deadOwner]
            .filter(item => !protectedIds.has(item.lease.targetId));
        const closeIds = new Set(closePlan.map(item => scopedTargetKey(item.lease)));
        store.leases = store.leases.map(lease => closeIds.has(scopedTargetKey(lease))
            ? { ...lease, state: 'closing', closePreviousState: lease.closePreviousState || lease.state, leaseDisposition: 'closing', updatedAt: nowIso() }
            : lease);
        writeStoreUnlocked(store);
    });
    const closed = await closePlanned(port, closePlan);
    return { closed: closed.length, closedTabs: closed.map(item => item.lease.targetId) };
}

export async function removeLease(targetId: string | null | undefined, scope: Partial<LeaseScopeInput> = {}): Promise<void> {
    if (!targetId) return;
    await withLeaseLock(() => {
        const store = readStoreUnlocked();
        const scoped = normalizeLease(stripUndefined({ ...scope, origin: scope.origin || undefined, vendor: scope.vendor || 'chatgpt', targetId }));
        if (!scoped) return;
        store.leases = store.leases.filter(lease => !sameTargetScope(lease, scoped));
        writeStoreUnlocked(store);
    });
}

export async function poolStats(): Promise<Record<string, number>> {
    const leases = await listLeases();
    return leases
        .filter(lease => lease.state === 'pooled')
        .reduce<Record<string, number>>((acc, lease) => {
            acc[lease.leaseKey] = (acc[lease.leaseKey] || 0) + 1;
            return acc;
        }, {});
}
