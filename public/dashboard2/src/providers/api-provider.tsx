import {
    createContext,
    useContext,
    useMemo,
    type JSX,
    type PropsWithChildren,
} from 'react';
import type { DashboardInstance } from '../../../../src/manager/types.ts';

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
    fetchInstances(): Promise<DashboardInstance[]>;
    fetchSessions(port: number): Promise<ChatSessionList>;
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

async function fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
}

function createManagerApiClient(): ManagerApiClient {
    return {
        async fetchInstances() {
            const response = await fetchJson<InstancesResponse>('/api/dashboard/instances');
            return response.instances;
        },
        async fetchSessions(port) {
            const response = await fetchJson<SessionsResponse>(`/i/${port}/api/chat-sessions`);
            if (response.ok !== true) {
                throw new Error('Instance returned an invalid session response');
            }
            return response.data;
        },
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
