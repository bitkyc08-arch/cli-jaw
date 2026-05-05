import {
    checkoutPooledLease,
    cleanupLeasedTabs,
    releaseCompletedLease,
    removeLease,
    poolStats,
    type LeaseScopeInput,
} from './tab-lease-store.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import type { WebAiVendor } from './types.js';

export interface PoolTabOptions extends Partial<LeaseScopeInput> {
    sessionId?: string | null;
}

export async function poolTab(
    vendor: WebAiVendor,
    targetId: string | null | undefined,
    url?: string,
    options: PoolTabOptions = {},
): Promise<void> {
    await releaseCompletedLease(stripUndefined({
        owner: options.owner || 'cli-jaw',
        vendor,
        sessionType: options.sessionType || 'jaw',
        browserProfileKey: options.browserProfileKey,
        origin: options.origin,
        port: options.port,
        targetId,
        sessionId: options.sessionId,
        url,
    }));
}

export async function getPooledTab(
    port: number,
    vendor: WebAiVendor,
    options: Partial<LeaseScopeInput> = {},
): Promise<{ targetId: string; url?: string | null } | null> {
    return checkoutPooledLease(stripUndefined({
        owner: options.owner || 'cli-jaw',
        vendor,
        sessionType: options.sessionType || 'jaw',
        browserProfileKey: options.browserProfileKey,
        origin: options.origin,
        url: options.url,
        port,
    }));
}

export async function unpoolTab(vendor: WebAiVendor, targetId: string | null | undefined, options: Partial<LeaseScopeInput> = {}): Promise<void> {
    await removeLease(targetId, stripUndefined({
        owner: options.owner || 'cli-jaw',
        vendor,
        sessionType: options.sessionType || 'jaw',
        browserProfileKey: options.browserProfileKey,
        origin: options.origin,
        url: options.url,
        port: options.port,
    }));
}

export async function cleanupPoolTabs(port: number): Promise<{ closed: number; closedTabs: string[] }> {
    return cleanupLeasedTabs(port);
}

export async function getPoolStats(): Promise<Record<string, number>> {
    return poolStats();
}
