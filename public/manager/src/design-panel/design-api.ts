import type {
    DesignCatalogEntry,
    DesignLocalPaths,
    DesignPageDetail,
    DesignPageSummary,
    DesignSnapshot,
} from './design-types';

/**
 * Typed client for `/api/dashboard/design/*` (186 Phase 3 surface). Phase 1
 * ships the client so the panel renders a graceful "store unavailable" state
 * against servers that predate the routes; Phase 2/3 light the backend up.
 */

const BASE = '/api/dashboard/design';

export class DesignApiUnavailableError extends Error {
    constructor(status: number) {
        super(`design store unavailable (${status})`);
        this.name = 'DesignApiUnavailableError';
    }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE}${path}`, init);
    if (response.status === 404 || response.status === 501) {
        throw new DesignApiUnavailableError(response.status);
    }
    const body = await response.json().catch(() => null) as (T & { ok?: boolean; error?: string }) | null;
    if (!response.ok || body === null) {
        throw new Error((body as { error?: string } | null)?.error ?? `design api failed: ${response.status}`);
    }
    return body;
}

export async function listDesignPages(projectKey?: string | null): Promise<DesignPageSummary[]> {
    const query = projectKey ? `?project=${encodeURIComponent(projectKey)}` : '';
    const body = await requestJson<{ pages?: DesignPageSummary[] }>(`/pages${query}`);
    return body.pages ?? [];
}

export async function getDesignPage(pageId: string): Promise<DesignPageDetail> {
    const body = await requestJson<{ page?: DesignPageDetail }>(`/pages/${encodeURIComponent(pageId)}`);
    if (!body.page) throw new Error('page not found');
    return body.page;
}

export async function createDesignPage(input: { title: string; projectKey?: string | null }): Promise<DesignPageDetail> {
    const body = await requestJson<{ page?: DesignPageDetail }>('/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    if (!body.page) throw new Error('create failed');
    return body.page;
}

export async function rescanDesignPages(projectKey?: string | null): Promise<{ scanned: number }> {
    const query = projectKey ? `?project=${encodeURIComponent(projectKey)}` : '';
    return requestJson<{ scanned: number }>(`/pages/rescan${query}`, { method: 'POST' });
}

export async function getDesignLocalPaths(pageId: string): Promise<DesignLocalPaths> {
    const body = await requestJson<{ paths?: DesignLocalPaths }>(`/pages/${encodeURIComponent(pageId)}/local-paths`);
    if (!body.paths) throw new Error('paths unavailable');
    return body.paths;
}

export async function exportDesignPage(pageId: string, target?: string): Promise<{ exportedTo: string }> {
    return requestJson<{ exportedTo: string }>(`/pages/${encodeURIComponent(pageId)}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target ? { target } : {}),
    });
}

export async function createDesignSnapshot(pageId: string, label: 'before' | 'after' | 'manual' = 'manual'): Promise<DesignSnapshot> {
    const body = await requestJson<{ snapshot?: DesignSnapshot }>(`/pages/${encodeURIComponent(pageId)}/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
    });
    if (!body.snapshot) throw new Error('snapshot failed');
    return body.snapshot;
}

export async function fetchDesignStoreVersion(): Promise<number> {
    const body = await requestJson<{ version?: number }>('/version');
    return body.version ?? 0;
}

export async function listDesignSnapshots(pageId: string): Promise<DesignSnapshot[]> {
    const body = await requestJson<{ snapshots?: DesignSnapshot[] }>(`/pages/${encodeURIComponent(pageId)}/snapshots`);
    return body.snapshots ?? [];
}

export async function listDesignCatalog(): Promise<DesignCatalogEntry[]> {
    const body = await requestJson<{ entries?: DesignCatalogEntry[] }>('/catalog');
    return body.entries ?? [];
}

/** Manager-served sandboxed preview URL for the iframe viewport. */
export function designPreviewUrl(pageId: string, revision?: number): string {
    const cacheBust = typeof revision === 'number' ? `?rev=${revision}` : '';
    return `${BASE}/pages/${encodeURIComponent(pageId)}/preview${cacheBust}`;
}
