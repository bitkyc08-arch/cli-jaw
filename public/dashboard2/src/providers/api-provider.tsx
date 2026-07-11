import {
    createContext,
    useContext,
    useMemo,
    type JSX,
    type PropsWithChildren,
} from 'react';
import type { DashboardInstance } from '../../../../src/manager/types.ts';
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
    fetchInstances(): Promise<DashboardInstance[]>;
    fetchSessions(port: number): Promise<ChatSessionList>;
}

export interface DashboardRegistryResponse {
    registry: DashboardRegistry;
    status: DashboardRegistryStatus;
}

export interface ManagerOriginClient {
    fetchInstances(): Promise<DashboardInstance[]>;
    fetchRegistry(): Promise<DashboardRegistryResponse>;
    patchRegistry(patch: DashboardRegistryPatch): Promise<DashboardRegistryResponse>;
}

export interface InstanceOriginClient {
    fetchSessions(): Promise<ChatSessionList>;
    fetchMessagesPage(opts: { limit?: number; before?: number }): Promise<MessagesPageResponse>;
    sendMessage(prompt: string, opts?: { signal?: AbortSignal; external?: boolean }): Promise<MessageResponse>;
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

interface SessionsResponse {
    ok: true;
    data: ChatSessionList;
}

const ManagerApiContext = createContext<ManagerApiClient | null>(null);

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
        async fetchInstances() {
            const response = await fetchJson<InstancesResponse>('/api/dashboard/instances');
            return response.instances;
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
        fetchInstances: () => manager.fetchInstances(),
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
