import type { SettingsRecord } from './settings-types.ts';

class SettingsRequestError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

function isRecord(value: unknown): value is SettingsRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeSettingsResponse(response: unknown): SettingsRecord {
    if (!isRecord(response)) throw new Error('Malformed settings response');
    if (response['ok'] === false) {
        throw new Error(typeof response['error'] === 'string' ? response['error'] : 'Settings request failed');
    }
    for (const key of ['registry', 'preferences', 'data'] as const) {
        if (!(key in response)) continue;
        const nested = response[key];
        if (!isRecord(nested)) throw new Error(`Malformed settings response: ${key}`);
        return nested;
    }
    return response;
}

async function request(path: string, init?: RequestInit): Promise<SettingsRecord> {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    if (init?.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new SettingsRequestError(response.status, detail || `Settings request failed (${response.status})`);
    }
    return normalizeSettingsResponse(await response.json() as unknown);
}

export async function fetchDashboardSettings(): Promise<SettingsRecord> {
    try {
        return await request('/api/dashboard/preferences');
    } catch (error) {
        if (!(error instanceof SettingsRequestError) || error.status !== 404) throw error;
        return request('/api/dashboard/registry');
    }
}

export async function saveDashboardSettings(patch: SettingsRecord): Promise<SettingsRecord> {
    const init: RequestInit = { method: 'PATCH', body: JSON.stringify(patch) };
    try {
        return await request('/api/dashboard/preferences', init);
    } catch (error) {
        if (!(error instanceof SettingsRequestError) || error.status !== 404) throw error;
        return request('/api/dashboard/registry', init);
    }
}

export function fetchInstanceSettings(port: number): Promise<SettingsRecord> {
    return request(`/i/${port}/api/settings`);
}

export function saveInstanceSettings(port: number, patch: SettingsRecord): Promise<SettingsRecord> {
    return request(`/i/${port}/api/settings`, {
        method: 'PUT',
        body: JSON.stringify(patch),
    });
}

export function unwrapSettings(response: SettingsRecord): SettingsRecord {
    return normalizeSettingsResponse(response);
}
