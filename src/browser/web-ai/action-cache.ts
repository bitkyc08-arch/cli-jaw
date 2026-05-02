import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CACHE_SCHEMA_VERSION } from './constants.js';
import { WebAiError, wrapError } from './errors.js';

const DEFAULT_HOME = process.env.BROWSER_AGENT_HOME || join(homedir(), '.browser-agent');
const CACHE_FILE = 'action-cache.json';
const STALE_MS = 30 * 86_400_000;

export interface ActionFingerprint {
    domHashPrefix?: string | null;
    axHashPrefix?: string | null;
}

export interface ActionCacheKeyInput {
    provider?: string | null;
    urlHost?: string | null;
    intent?: string | null;
    actionKind?: string | null;
    domHashPrefix?: string | null;
    axHashPrefix?: string | null;
}

export interface ResolvedActionTarget {
    selector?: string | null;
    role?: string | null;
    name?: string | null;
    schemaVersion?: number;
    contractVersion?: string | null;
    framePath?: string | null;
    browserConfigHash?: string | null;
    [key: string]: unknown;
}

export interface ActionCacheEntry {
    schemaVersion: number;
    provider?: string | null;
    intent?: string | null;
    actionKind?: string | null;
    urlHost?: string | null;
    pageFingerprint: ActionFingerprint;
    contractVersion: string | null;
    framePath: string | null;
    browserConfigHash: string | null;
    target: ResolvedActionTarget & {
        nameHash?: string | null;
        nameChars?: number;
        signatureHash?: string;
    };
    stats: {
        hitCount: number;
        lastValidatedAt: string;
    };
}

export interface ActionCache {
    schemaVersion: number;
    entries: Record<string, ActionCacheEntry>;
}

export interface CachedTargetLookup {
    target: ResolvedActionTarget;
    key: string;
    entry: ActionCacheEntry;
}

export interface ActionCacheHandle {
    get(lookupCtx: {
        provider?: string | null;
        intent?: string | null;
        actionKind?: string | null;
        urlHost?: string | null;
        fingerprint?: ActionFingerprint | null;
    }): CachedTargetLookup | null;
    update(
        ctx: { provider?: string | null; intent?: string | null; actionKind?: string | null; urlHost?: string | null },
        resolvedTarget: ResolvedActionTarget,
        fingerprint?: ActionFingerprint | null,
        meta?: { contractVersion?: string; framePath?: string | null; browserConfigHash?: string | null },
    ): void;
    save(): void;
    raw(): ActionCache;
}

export function cacheKey({ provider, urlHost, intent, actionKind, domHashPrefix, axHashPrefix }: ActionCacheKeyInput): string {
    return [
        'v2',
        provider || '*',
        urlHost || '*',
        intent || '*',
        actionKind || '*',
        domHashPrefix || '*',
        axHashPrefix || '*',
    ].join('|');
}

export function loadActionCache(homeDir = DEFAULT_HOME): ActionCache {
    const path = join(homeDir, CACHE_FILE);
    if (!existsSync(path)) return createEmptyCache();
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ActionCache>;
        if (raw.schemaVersion !== CACHE_SCHEMA_VERSION) return createEmptyCache();
        const now = Date.now();
        const entries: Record<string, ActionCacheEntry> = {};
        for (const [key, entry] of Object.entries(raw.entries || {})) {
            const lastValidated = entry.stats?.lastValidatedAt ? new Date(entry.stats.lastValidatedAt).getTime() : 0;
            if (now - lastValidated < STALE_MS) entries[key] = entry;
        }
        return { schemaVersion: CACHE_SCHEMA_VERSION, entries };
    } catch (err) {
        void wrapError(err, { stage: 'action-cache-load', retryHint: 'reset-cache' });
        return createEmptyCache();
    }
}

export function saveActionCache(cache: ActionCache, homeDir = DEFAULT_HOME): void {
    try {
        mkdirSync(homeDir, { recursive: true });
        const path = join(homeDir, CACHE_FILE);
        const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
        renameSync(tmpPath, path);
    } catch (err) {
        throw wrapError(err, {
            errorCode: 'internal.unhandled',
            stage: 'action-cache-save',
            retryHint: 'check-filesystem',
        });
    }
}

export function getCachedTarget(
    cache: ActionCache | null | undefined,
    input: {
        provider?: string | null;
        intent?: string | null;
        actionKind?: string | null;
        urlHost?: string | null;
        fingerprint?: ActionFingerprint | null;
    },
): CachedTargetLookup | null {
    if (!cache?.entries) return null;
    const key = cacheKey({
        provider: input.provider,
        urlHost: input.urlHost,
        intent: input.intent,
        actionKind: input.actionKind,
        domHashPrefix: input.fingerprint?.domHashPrefix || null,
        axHashPrefix: input.fingerprint?.axHashPrefix || null,
    });
    const entry = cache.entries[key];
    if (!entry) return null;
    return {
        target: {
            ...entry.target,
            schemaVersion: entry.schemaVersion,
            contractVersion: entry.contractVersion,
            framePath: entry.framePath,
            browserConfigHash: entry.browserConfigHash,
        },
        key,
        entry,
    };
}

export function updateCacheEntry(
    cache: ActionCache | null | undefined,
    ctx: { provider?: string | null; intent?: string | null; actionKind?: string | null; urlHost?: string | null },
    resolvedTarget: ResolvedActionTarget,
    fingerprint?: ActionFingerprint | null,
    meta: { contractVersion?: string; framePath?: string | null; browserConfigHash?: string | null } = {},
): void {
    if (!cache || !resolvedTarget?.selector) return;
    const { provider, intent, actionKind, urlHost } = ctx;
    const key = cacheKey({
        provider,
        urlHost,
        intent,
        actionKind,
        domHashPrefix: fingerprint?.domHashPrefix || null,
        axHashPrefix: fingerprint?.axHashPrefix || null,
    });
    const existing = cache.entries[key];
    cache.entries[key] = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        provider,
        intent,
        actionKind,
        urlHost: urlHost || null,
        pageFingerprint: fingerprint || {},
        contractVersion: meta.contractVersion || '1.0',
        framePath: meta.framePath || null,
        browserConfigHash: meta.browserConfigHash || null,
        target: {
            selector: resolvedTarget.selector,
            role: resolvedTarget.role || null,
            nameHash: resolvedTarget.name ? hashField(resolvedTarget.name) : null,
            nameChars: resolvedTarget.name ? String(resolvedTarget.name).length : 0,
            signatureHash: signatureHash({ provider, intent, actionKind, role: resolvedTarget.role, selector: resolvedTarget.selector }),
        },
        stats: {
            hitCount: (existing?.stats?.hitCount || 0) + 1,
            lastValidatedAt: new Date().toISOString(),
        },
    };
}

export function createActionCacheHandle(homeDir = DEFAULT_HOME): ActionCacheHandle {
    const cache = loadActionCache(homeDir);
    return {
        get(lookupCtx) {
            return getCachedTarget(cache, lookupCtx);
        },
        update(ctx, resolvedTarget, fingerprint, meta) {
            updateCacheEntry(cache, ctx, resolvedTarget, fingerprint, meta);
        },
        save() {
            saveActionCache(cache, homeDir);
        },
        raw() {
            return cache;
        },
    };
}

function createEmptyCache(): ActionCache {
    return { schemaVersion: CACHE_SCHEMA_VERSION, entries: {} };
}

function hashField(value: unknown): string {
    return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

function signatureHash(input: { provider?: string | null; intent?: string | null; actionKind?: string | null; role?: string | null; selector?: string | null }): string {
    const value = [input.provider, input.intent, input.actionKind, input.role, input.selector].join('|');
    return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function actionCacheError(message: string, evidence?: unknown): WebAiError {
    return new WebAiError({
        errorCode: 'internal.unhandled',
        stage: 'action-cache',
        retryHint: 'report',
        message,
        evidence,
    });
}
