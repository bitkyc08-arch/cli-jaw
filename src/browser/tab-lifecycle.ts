import { closeTab, listTabs, type BrowserTabInfo } from './connection.js';
import { listSessions } from './web-ai/session.js';
import { listLeases, type TabLease } from './web-ai/tab-lease-store.js';

const DEFAULT_MAX_TABS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const pinnedTabs = new Set<string>();

export interface TabCleanupCandidate extends BrowserTabInfo {
    cleanupReason: 'idle-timeout' | 'max-tabs' | 'untracked' | 'provider-overflow';
}

export interface TabCleanupOptions {
    now?: number;
    idleTimeoutMs?: number;
    maxTabs?: number;
    includeUntracked?: boolean;
    provider?: string;
    keepProviderTabs?: number;
}

type LeaseOwnership = Pick<TabLease, 'owner' | 'state'>;

export interface TabCleanupSummary {
    closed: number;
    idleClosed: number;
    limitClosed: number;
    untrackedClosed: number;
    providerClosed: number;
}

const PROVIDER_ORIGINS: Record<string, string> = {
    chatgpt: 'https://chatgpt.com',
    gemini: 'https://gemini.google.com',
    grok: 'https://grok.com',
};

export function parseTabDuration(value: string | number | null | undefined): number {
    const raw = String(value || '').trim();
    const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(raw);
    if (!match) return DEFAULT_IDLE_TIMEOUT_MS;
    const n = Number(match[1]);
    const unit = (match[2] || 'm').toLowerCase();
    if (unit === 'ms') return n;
    if (unit === 's') return n * 1000;
    if (unit === 'h') return n * 3_600_000;
    return n * 60_000;
}

export function pinTab(targetId: string): void {
    pinnedTabs.add(targetId);
}

export function unpinTab(targetId: string): void {
    pinnedTabs.delete(targetId);
}

export function isPinned(targetId: string): boolean {
    return pinnedTabs.has(targetId);
}

export function selectTabsForCleanup({
    tabs,
    activeSessionTargetIds = new Set<string>(),
    pinnedTargetIds = new Set<string>(),
    now = Date.now(),
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxTabs = DEFAULT_MAX_TABS,
    includeUntracked = false,
    leaseByTargetId,
}: {
    tabs: BrowserTabInfo[];
    activeSessionTargetIds?: Set<string>;
    pinnedTargetIds?: Set<string>;
    now?: number;
    idleTimeoutMs?: number;
    maxTabs?: number;
    includeUntracked?: boolean;
    leaseByTargetId?: Map<string, LeaseOwnership>;
}): TabCleanupCandidate[] {
    const selected = new Map<string, TabCleanupCandidate>();
    const hasLeaseMetadata = Boolean(leaseByTargetId);
    const isCloseableByOwnership = (tab: BrowserTabInfo): boolean => {
        const lease = leaseByTargetId?.get(tab.targetId);
        if (!hasLeaseMetadata) return true;
        if (!lease) return includeUntracked;
        if (!['cli-jaw', 'web-ai'].includes(lease.owner)) return includeUntracked;
        return ['pooled', 'completed-session', 'closing'].includes(lease.state);
    };
    const closeable = tabs.filter(tab =>
        tab.targetId &&
        !pinnedTargetIds.has(tab.targetId) &&
        !activeSessionTargetIds.has(tab.targetId) &&
        isCloseableByOwnership(tab)
    );

    for (const tab of closeable) {
        const lastActiveAt = Number(tab.lastActiveAt);
        const tracked = Number.isFinite(lastActiveAt) && lastActiveAt > 0;
        if ((tracked && now - lastActiveAt > idleTimeoutMs) || (!tracked && includeUntracked)) {
            selected.set(tab.targetId, {
                ...tab,
                cleanupReason: tracked ? 'idle-timeout' : 'untracked',
            });
        }
    }

    const remaining = tabs.filter(tab => tab.targetId && !selected.has(tab.targetId));
    const remainingCloseable = remaining.filter(tab => {
        const lastActiveAt = Number(tab.lastActiveAt);
        const tracked = Number.isFinite(lastActiveAt) && lastActiveAt > 0;
        return !pinnedTargetIds.has(tab.targetId) &&
            !activeSessionTargetIds.has(tab.targetId) &&
            isCloseableByOwnership(tab) &&
            (tracked || includeUntracked);
    });

    const managedCount = hasLeaseMetadata ? remainingCloseable.length : remaining.length;
    if (managedCount > maxTabs) {
        const limitCloseCount = managedCount - maxTabs;
        const oldest = remainingCloseable
            .slice()
            .sort((a, b) => (Number(a.lastActiveAt) || 0) - (Number(b.lastActiveAt) || 0))
            .slice(0, limitCloseCount);
        for (const tab of oldest) {
            selected.set(tab.targetId, { ...tab, cleanupReason: 'max-tabs' });
        }
    }

    return Array.from(selected.values());
}

export function selectProviderTabsForCleanup({
    tabs,
    provider,
    keep = 1,
    activeSessionTargetIds = new Set<string>(),
    pinnedTargetIds = new Set<string>(),
}: {
    tabs: BrowserTabInfo[];
    provider: string;
    keep?: number;
    activeSessionTargetIds?: Set<string>;
    pinnedTargetIds?: Set<string>;
}): TabCleanupCandidate[] {
    const origin = PROVIDER_ORIGINS[String(provider || '').toLowerCase()];
    if (!origin) return [];
    const keepCount = Math.max(0, Number.isFinite(keep) ? Math.trunc(keep) : 1);
    const candidates = tabs
        .filter(tab => tab.targetId && tab.type === 'page')
        .filter(tab => !activeSessionTargetIds.has(tab.targetId))
        .filter(tab => !pinnedTargetIds.has(tab.targetId))
        .filter(tab => {
            try {
                return new URL(tab.url || '').origin === origin;
            } catch {
                return false;
            }
        })
        .sort((a, b) => (Number(b.lastActiveAt) || 0) - (Number(a.lastActiveAt) || 0));
    return candidates.slice(keepCount).map(tab => ({ ...tab, cleanupReason: 'provider-overflow' }));
}

export async function cleanupIdleTabs(port: number, opts: TabCleanupOptions = {}): Promise<TabCleanupSummary> {
    const tabs = await listTabs(port);
    const leases = await listLeases();
    const leaseByTargetId = new Map(leases.map(lease => [lease.targetId, lease]));
    const activeSessionTargetIds = new Set<string>();
    for (const session of [...listSessions({ status: 'sent' }), ...listSessions({ status: 'streaming' })]) {
        if (session.targetId) activeSessionTargetIds.add(session.targetId);
    }

    const candidates = selectTabsForCleanup({
        tabs,
        activeSessionTargetIds,
        pinnedTargetIds: pinnedTabs,
        now: opts.now || Date.now(),
        idleTimeoutMs: opts.idleTimeoutMs || parseTabDuration(process.env.JAW_BROWSER_TAB_IDLE || '30m'),
        maxTabs: opts.maxTabs ?? Number(process.env.JAW_BROWSER_MAX_TABS || DEFAULT_MAX_TABS),
        includeUntracked: opts.includeUntracked === true,
        leaseByTargetId,
    });
    if (opts.provider) {
        for (const tab of selectProviderTabsForCleanup({
            tabs,
            provider: opts.provider,
            keep: opts.keepProviderTabs ?? 1,
            activeSessionTargetIds,
            pinnedTargetIds: pinnedTabs,
        })) {
            if (!candidates.some(candidate => candidate.targetId === tab.targetId)) {
                candidates.push(tab);
            }
        }
    }

    const summary: TabCleanupSummary = { closed: 0, idleClosed: 0, limitClosed: 0, untrackedClosed: 0, providerClosed: 0 };
    for (const tab of candidates) {
        try {
            await closeTab(port, tab.targetId);
            summary.closed += 1;
            if (tab.cleanupReason === 'idle-timeout') summary.idleClosed += 1;
            else if (tab.cleanupReason === 'max-tabs') summary.limitClosed += 1;
            else if (tab.cleanupReason === 'untracked') summary.untrackedClosed += 1;
            else if (tab.cleanupReason === 'provider-overflow') summary.providerClosed += 1;
        } catch {
            // Tab may already be closed by the user or Chrome.
        }
    }
    return summary;
}
