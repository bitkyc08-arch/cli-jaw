import type {
    DashboardRegistry,
    DashboardRegistryPatch,
    DashboardRegistryStatus,
} from '../../../../../src/manager/types.ts';
import type { SettingsRecord } from './settings-types.ts';

export type SettingsRequestErrorCode =
    | 'request_failed'
    | 'http_error'
    | 'invalid_content_type'
    | 'invalid_json'
    | 'invalid_response';

export class SettingsRequestError extends Error {
    readonly code: SettingsRequestErrorCode;
    readonly status: number | null;

    constructor(code: SettingsRequestErrorCode, message: string, status: number | null = null) {
        super(message);
        this.name = 'SettingsRequestError';
        this.code = code;
        this.status = status;
    }
}

export interface DashboardRegistryResponse {
    registry: DashboardRegistry;
    status: DashboardRegistryStatus;
}

export interface SettingsRequestOptions {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is SettingsRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalidResponse(kind: string): SettingsRequestError {
    return new SettingsRequestError('invalid_response', `${kind} returned an invalid response`);
}

export function decodeDashboardRegistryResponse(value: unknown): DashboardRegistryResponse {
    if (!isRecord(value) || !isRecord(value['registry']) || !isRecord(value['status'])) {
        throw invalidResponse('Dashboard registry');
    }
    return {
        registry: value['registry'] as DashboardRegistry,
        status: value['status'] as DashboardRegistryStatus,
    };
}

export function decodeWorkerSettingsResponse(value: unknown): SettingsRecord {
    if (!isRecord(value) || value['ok'] !== true || !isRecord(value['data'])) {
        throw invalidResponse('Worker settings');
    }
    return value['data'];
}

export function decodeCliRegistryResponse(value: unknown): SettingsRecord {
    if (!isRecord(value) || value['ok'] !== true || !isRecord(value['data'])) {
        throw invalidResponse('CLI registry');
    }
    return value['data'];
}

function isJsonContentType(value: string | null): boolean {
    if (!value) return false;
    const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    return mediaType === 'application/json' || (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
}

async function request<T>(
    path: string,
    decode: (value: unknown) => T,
    init: RequestInit | undefined,
    options: SettingsRequestOptions,
): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    if (init?.body !== undefined) headers.set('Content-Type', 'application/json');
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
        response = await fetchImpl(path, {
            ...init,
            headers,
            ...(options.signal ? { signal: options.signal } : {}),
        });
    } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new SettingsRequestError('request_failed', 'Settings request failed');
    }
    if (!response.ok) {
        throw new SettingsRequestError(
            'http_error',
            `Settings request failed (${response.status})`,
            response.status,
        );
    }
    if (!isJsonContentType(response.headers.get('content-type'))) {
        throw new SettingsRequestError(
            'invalid_content_type',
            'Settings request returned a non-JSON response',
            response.status,
        );
    }
    let body: unknown;
    try {
        body = await response.json() as unknown;
    } catch {
        throw new SettingsRequestError(
            'invalid_json',
            'Settings request returned invalid JSON',
            response.status,
        );
    }
    return decode(body);
}

export function fetchDashboardRegistry(options: SettingsRequestOptions = {}): Promise<DashboardRegistryResponse> {
    return request('/api/dashboard/registry', decodeDashboardRegistryResponse, undefined, options);
}

export function patchDashboardRegistry(
    patch: DashboardRegistryPatch,
    options: SettingsRequestOptions = {},
): Promise<DashboardRegistryResponse> {
    return request('/api/dashboard/registry', decodeDashboardRegistryResponse, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    }, options);
}

export function fetchInstanceSettings(
    port: number,
    options: SettingsRequestOptions = {},
): Promise<SettingsRecord> {
    return request(`/i/${port}/api/settings`, decodeWorkerSettingsResponse, undefined, options);
}

export function saveInstanceSettings(
    port: number,
    patch: SettingsRecord,
    options: SettingsRequestOptions = {},
): Promise<SettingsRecord> {
    return request(`/i/${port}/api/settings`, decodeWorkerSettingsResponse, {
        method: 'PUT',
        body: JSON.stringify(patch),
    }, options);
}

export function fetchCliRegistry(
    port: number,
    options: SettingsRequestOptions = {},
): Promise<SettingsRecord> {
    return request(`/i/${port}/api/cli-registry`, decodeCliRegistryResponse, undefined, options);
}

// Compatibility names for existing settings consumers. Both now use the
// canonical dashboard registry endpoint and its exact response decoder.
export async function fetchDashboardSettings(options: SettingsRequestOptions = {}): Promise<SettingsRecord> {
    return (await fetchDashboardRegistry(options)).registry as unknown as SettingsRecord;
}

export async function saveDashboardSettings(
    patch: DashboardRegistryPatch | SettingsRecord,
    options: SettingsRequestOptions = {},
): Promise<SettingsRecord> {
    return (await patchDashboardRegistry(patch as DashboardRegistryPatch, options)).registry as unknown as SettingsRecord;
}
