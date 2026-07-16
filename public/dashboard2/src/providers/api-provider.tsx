import {
    createContext,
    useContext,
    useMemo,
    type JSX,
    type PropsWithChildren,
} from 'react';
import type {
    DashboardInstance,
    DashboardLifecycleAction,
    DashboardLifecycleResult,
    DashboardScanResult,
} from '../../../../src/manager/types.ts';
import type {
    DashboardRegistry,
    DashboardRegistryPatch,
    DashboardRegistryStatus,
} from '../../../../src/manager/types.ts';
import type { MessagesPageResponse } from '../../../../src/shared/chat-events.ts';

export interface ChatSessionRow {
    id: string;
    seq: number;
    label: string | null;
    created_at: string;
    updated_at: string;
    message_count: number;
}

export interface ChatSessionList {
    sessions: ChatSessionRow[];
    active: string;
}

export interface ManagerApiClient {
    manager: ManagerOriginClient;
    instance(port: number): InstanceOriginClient;
    fetchInstances(opts?: { signal?: AbortSignal }): Promise<DashboardInstance[]>;
    fetchSessions(port: number): Promise<ChatSessionList>;
}

export interface DashboardRegistryResponse {
    registry: DashboardRegistry;
    status: DashboardRegistryStatus;
}

export interface ManagerOriginClient {
    fetchInstances(opts?: { signal?: AbortSignal }): Promise<DashboardInstance[]>;
    fetchInstance(port: number, opts?: { signal?: AbortSignal }): Promise<DashboardInstanceResponse>;
    runLifecycleAction(
        action: DashboardLifecycleAction,
        port: number,
        home?: string,
        opts?: { signal?: AbortSignal },
    ): Promise<DashboardLifecycleResult>;
    fetchRegistry(): Promise<DashboardRegistryResponse>;
    patchRegistry(patch: DashboardRegistryPatch): Promise<DashboardRegistryResponse>;
}

export interface InstanceOriginClient {
    fetchSessions(): Promise<ChatSessionList>;
    fetchMessagesPage(opts: { limit?: number; before?: number }): Promise<MessagesPageResponse>;
    sendMessage(prompt: string, opts?: { signal?: AbortSignal; external?: boolean }): Promise<MessageResponse>;
    /** stop the active run on this instance (POST /api/stop) */
    stopAgent(): Promise<{ ok: boolean }>;
    uploadAttachment(file: File, opts?: { signal?: AbortSignal }): Promise<AttachmentUploadResponse>;
    transcribeVoice(blob: Blob, opts?: { signal?: AbortSignal; extension?: string }): Promise<VoiceTranscriptionResponse>;
}

export interface MessageResponse {
    ok: boolean;
    command?: boolean;
    action?: string;
    reason?: string;
    error?: string;
    [key: string]: unknown;
}

export interface AttachmentUploadResponse {
    path: string;
    filename: string;
}

export interface VoiceTranscriptionResponse {
    ok: true;
    text: string;
    engine: string;
    elapsed: number;
}

interface InstancesResponse {
    manager: unknown;
    instances: DashboardInstance[];
    peerDashboards: DashboardInstance[];
    platform: string;
}

export interface DashboardInstanceResponse {
    ok: true;
    instance: DashboardInstance | null;
    manager?: DashboardScanResult['manager'];
    platform: string;
}

export interface ManagerApiErrorResponse {
    ok: false;
    error: string;
}

interface ManagerApiErrorOptions {
    status: number | null;
    retryable: boolean;
    envelope?: ManagerApiErrorResponse;
    result?: DashboardLifecycleResult;
}

export class ManagerApiError extends Error {
    readonly status: number | null;
    readonly retryable: boolean;
    readonly envelope?: ManagerApiErrorResponse;
    readonly result?: DashboardLifecycleResult;

    constructor(message: string, options: ManagerApiErrorOptions) {
        super(message);
        this.name = 'ManagerApiError';
        this.status = options.status;
        this.retryable = options.retryable;
        if (options.envelope) this.envelope = options.envelope;
        if (options.result) this.result = options.result;
    }
}

interface SessionsResponse {
    ok: true;
    data: ChatSessionList;
}

const ManagerApiContext = createContext<ManagerApiClient | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isErrorEnvelope(value: unknown): value is ManagerApiErrorResponse {
    return isRecord(value) && value['ok'] === false && typeof value['error'] === 'string';
}

function isInstanceResponse(value: unknown, expectedPort: number): value is DashboardInstanceResponse {
    if (!isRecord(value)
        || value['ok'] !== true
        || !('instance' in value)
        || (value['instance'] !== null && !isRecord(value['instance']))
        || typeof value['platform'] !== 'string') return false;
    if (value['instance'] !== null && value['instance']['port'] !== expectedPort) return false;
    return !('manager' in value) || isRecord(value['manager']);
}

function isLifecycleResult(value: unknown): value is DashboardLifecycleResult {
    if (!isRecord(value)) return false;
    const action = value['action'];
    const status = value['status'];
    return typeof value['ok'] === 'boolean'
        && ['start', 'stop', 'restart', 'perm', 'unperm'].includes(String(action))
        && Number.isInteger(value['port'])
        && ['started', 'stopped', 'restarted', 'permed', 'unpermed', 'rejected', 'error', 'skipped'].includes(String(status))
        && typeof value['message'] === 'string'
        && (value['home'] === null || typeof value['home'] === 'string')
        && (value['pid'] === null || typeof value['pid'] === 'number')
        && Array.isArray(value['command'])
        && value['command'].every(part => typeof part === 'string');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function fetchManagerResponse(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    try {
        return await fetch(path, { ...init, headers });
    } catch (error) {
        if (init?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        throw new ManagerApiError(errorMessage(error), { status: null, retryable: true });
    }
}

async function parseJson(response: Response): Promise<unknown> {
    return response.json().catch(() => null) as Promise<unknown>;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
}

function createManagerApiClient(): ManagerApiClient {
    const manager: ManagerOriginClient = {
        async fetchInstances(opts) {
            const response = await fetchJson<InstancesResponse>('/api/dashboard/instances', {
                ...(opts?.signal ? { signal: opts.signal } : {}),
            });
            return response.instances;
        },
        async fetchInstance(port, opts) {
            const response = await fetchManagerResponse(`/api/dashboard/instances/${port}`, {
                ...(opts?.signal ? { signal: opts.signal } : {}),
            });
            const body = await parseJson(response);
            if (!response.ok) {
                const envelope = isErrorEnvelope(body) ? body : undefined;
                throw new ManagerApiError(
                    envelope?.error || `Request failed (${response.status})`,
                    {
                        status: response.status,
                        retryable: response.status >= 500,
                        ...(envelope ? { envelope } : {}),
                    },
                );
            }
            if (!isInstanceResponse(body, port)) {
                throw new ManagerApiError('Instance returned an invalid response', {
                    status: response.status,
                    retryable: false,
                });
            }
            return body;
        },
        async runLifecycleAction(action, port, home, opts) {
            const response = await fetchManagerResponse(`/api/dashboard/lifecycle/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port, ...(home !== undefined ? { home } : {}) }),
                ...(opts?.signal ? { signal: opts.signal } : {}),
            });
            const body = await parseJson(response);
            if (!isLifecycleResult(body) || body.action !== action || body.port !== port) {
                throw new ManagerApiError(`Lifecycle ${action} returned an invalid response`, {
                    status: response.status,
                    retryable: false,
                });
            }
            if (!response.ok || body.ok !== true) {
                throw new ManagerApiError(body.message, {
                    status: response.status,
                    retryable: false,
                    result: body,
                });
            }
            return body;
        },
        fetchRegistry() {
            return fetchJson<DashboardRegistryResponse>('/api/dashboard/registry');
        },
        patchRegistry(patch) {
            return fetchJson<DashboardRegistryResponse>('/api/dashboard/registry', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
        },
    };

    const instance = (port: number): InstanceOriginClient => ({
        async fetchSessions() {
            const response = await fetchJson<SessionsResponse>(`/i/${port}/api/chat-sessions`);
            if (response.ok !== true) {
                throw new Error('Instance returned an invalid session response');
            }
            return response.data;
        },
        fetchMessagesPage(opts) {
            const params = new URLSearchParams('includeSegments=1');
            if (opts.limit !== undefined) params.set('limit', String(opts.limit));
            if (opts.before !== undefined) params.set('before', String(opts.before));
            return fetchJson<MessagesPageResponse>(`/i/${port}/api/messages?${params.toString()}`);
        },
        sendMessage(prompt, opts) {
            return fetchJson<MessageResponse>(`/i/${port}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, external: opts?.external }),
                ...(opts?.signal ? { signal: opts.signal } : {}),
            });
        },
        stopAgent() {
            return fetchJson<{ ok: boolean }>(`/i/${port}/api/stop`, { method: 'POST' });
        },
        uploadAttachment(file, opts) {
            return fetchJson<AttachmentUploadResponse>(`/i/${port}/api/upload`, {
                method: 'POST',
                headers: {
                    'Content-Type': file.type || 'application/octet-stream',
                    'X-Filename': encodeURIComponent(file.name),
                },
                body: file,
                ...(opts?.signal ? { signal: opts.signal } : {}),
            });
        },
        transcribeVoice(blob, opts) {
            return fetchJson<VoiceTranscriptionResponse>(`/i/${port}/api/voice`, {
                method: 'POST',
                headers: {
                    'Content-Type': blob.type || 'audio/webm',
                    'X-Voice-Ext': opts?.extension || '.webm',
                    'X-STT-Only': 'true',
                },
                body: blob,
                ...(opts?.signal ? { signal: opts.signal } : {}),
            });
        },
    });

    return {
        manager,
        instance,
        fetchInstances: opts => manager.fetchInstances(opts),
        fetchSessions: (port) => instance(port).fetchSessions(),
    };
}

export function ManagerApiProvider(props: PropsWithChildren): JSX.Element {
    const client = useMemo(createManagerApiClient, []);
    return (
        <ManagerApiContext.Provider value={client}>
            {props.children}
        </ManagerApiContext.Provider>
    );
}

export function useManagerApi(): ManagerApiClient {
    const client = useContext(ManagerApiContext);
    if (!client) {
        throw new Error('useManagerApi must be used inside ManagerApiProvider');
    }
    return client;
}
