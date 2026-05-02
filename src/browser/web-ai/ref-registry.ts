import { WebAiError } from './errors.js';

export interface RefRegistry {
    snapshotId: string | null;
    axHash: string | null;
    domHash: string | null;
    refs: Record<string, RefEntry>;
    createdAt: number;
    stale: boolean;
    invalidatedAt: number | null;
}

export interface RefEntry {
    ref: string;
    role: string;
    name: string;
    selector: string | null;
    framePath: string[];
    shadowPath: string[];
    signatureHash: string;
}

export interface RefRegistryInput {
    snapshotId?: string | null;
    axHash?: string | null;
    domHash?: string | null;
    refs?: Record<string, RefEntry>;
}

export interface ResolveRefOptions {
    expectedSnapshotId?: string | null;
    currentDomHash?: string | null;
    currentAxHash?: string | null;
    allowStale?: boolean;
}

export interface InvalidateOptions {
    domHash?: string | null;
    axHash?: string | null;
}

export interface StaleCheckOptions {
    expectedSnapshotId?: string | null;
    currentDomHash?: string | null;
    currentAxHash?: string | null;
}

export interface RefRegistryPageLike {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

export function createRefRegistry(snapshot: RefRegistryInput | null | undefined): RefRegistry {
    return {
        snapshotId: snapshot?.snapshotId || null,
        axHash: snapshot?.axHash || null,
        domHash: snapshot?.domHash || null,
        refs: { ...(snapshot?.refs || {}) },
        createdAt: Date.now(),
        stale: false,
        invalidatedAt: null,
    };
}

export async function resolveRef(
    page: RefRegistryPageLike,
    registry: RefRegistry | null | undefined,
    ref: string | number,
    {
        expectedSnapshotId = null,
        currentDomHash = null,
        currentAxHash = null,
        allowStale = false,
    }: ResolveRefOptions = {},
): Promise<RefEntry> {
    void page;
    const normalized = normalizeRef(ref);
    if (!allowStale) {
        assertRegistryFresh(registry, { expectedSnapshotId, currentDomHash, currentAxHash, ref: normalized });
    }
    const entry = registry?.refs?.[normalized];
    if (!entry) {
        throw new WebAiError({
            errorCode: 'snapshot.ref-not-found',
            stage: 'snapshot-ref-resolve',
            retryHint: 're-snapshot',
            message: `ref ${normalized} not found in current snapshot registry`,
            evidence: { ref: normalized, snapshotId: registry?.snapshotId || null },
        });
    }
    return entry;
}

export function invalidateRefsOnDomChange(
    registry: RefRegistry | null | undefined,
    { domHash = null, axHash = null }: InvalidateOptions = {},
): boolean {
    if (!registry) return false;
    const changed = (domHash && registry.domHash && domHash !== registry.domHash)
        || (axHash && registry.axHash && axHash !== registry.axHash);
    if (!changed) return false;
    registry.refs = {};
    registry.domHash = domHash || registry.domHash;
    registry.axHash = axHash || registry.axHash;
    registry.stale = true;
    registry.invalidatedAt = Date.now();
    return true;
}

export function isRegistryStale(
    registry: RefRegistry | null | undefined,
    {
        expectedSnapshotId = null,
        currentDomHash = null,
        currentAxHash = null,
    }: StaleCheckOptions = {},
): boolean {
    if (!registry || registry.stale === true) return true;
    if (expectedSnapshotId && registry.snapshotId !== expectedSnapshotId) return true;
    if (currentDomHash && registry.domHash && currentDomHash !== registry.domHash) return true;
    if (currentAxHash && registry.axHash && currentAxHash !== registry.axHash) return true;
    return false;
}

function assertRegistryFresh(
    registry: RefRegistry | null | undefined,
    context: StaleCheckOptions & { ref?: string } = {},
): void {
    if (!isRegistryStale(registry, context)) return;
    throw new WebAiError({
        errorCode: 'snapshot.ref-stale',
        stage: 'snapshot-ref-resolve',
        retryHint: 're-snapshot',
        message: `ref ${context.ref || ''} belongs to a stale snapshot registry`.trim(),
        evidence: {
            snapshotId: registry?.snapshotId || null,
            expectedSnapshotId: context.expectedSnapshotId || null,
            domHash: registry?.domHash || null,
            currentDomHash: context.currentDomHash || null,
            axHash: registry?.axHash || null,
            currentAxHash: context.currentAxHash || null,
        },
    });
}

function normalizeRef(ref: string | number): string {
    const value = String(ref || '').trim();
    if (!value) return value;
    if (value.startsWith('@')) return value;
    return `@${value}`;
}
