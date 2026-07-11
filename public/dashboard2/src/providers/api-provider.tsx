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
