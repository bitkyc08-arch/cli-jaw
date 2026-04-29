import type {
    DashboardInstance,
    DashboardLifecycleAction,
    DashboardLifecycleResult,
    DashboardProcessControlState,
    DashboardRegistryLoadResult,
    DashboardRegistryPatch,
    DashboardScanResult,
    HealthEvent,
    InstanceLogSnapshot,
    ManagerEvent,
} from './types';

export async function fetchInstances(showHidden = false): Promise<DashboardScanResult> {
    const path = showHidden ? '/api/dashboard/instances?showHidden=1' : '/api/dashboard/instances';
    const response = await fetch(path);
    if (!response.ok) throw new Error(`scan failed: ${response.status}`);
    return await response.json() as DashboardScanResult;
}

export async function fetchRegistry(): Promise<DashboardRegistryLoadResult> {
    const response = await fetch('/api/dashboard/registry');
    if (!response.ok) throw new Error(`registry load failed: ${response.status}`);
    return await response.json() as DashboardRegistryLoadResult;
}

export async function patchDashboardRegistry(patch: DashboardRegistryPatch): Promise<DashboardRegistryLoadResult> {
    const response = await fetch('/api/dashboard/registry', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error(`registry save failed: ${response.status}`);
    return await response.json() as DashboardRegistryLoadResult;
}

export async function runLifecycleAction(
    action: DashboardLifecycleAction,
    port: number,
    home?: string,
): Promise<DashboardLifecycleResult> {
    const response = await fetch(`/api/dashboard/lifecycle/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port, ...(home?.trim() ? { home: home.trim() } : {}) }),
    });
    const result = await response.json() as DashboardLifecycleResult;
    if (!response.ok || !result.ok) {
        throw new Error(result.message || `${action} failed: ${response.status}`);
    }
    return result;
}

export async function fetchProcessControlState(): Promise<DashboardProcessControlState> {
    const response = await fetch('/api/dashboard/process-control');
    if (!response.ok) throw new Error(`process control fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; state: DashboardProcessControlState };
    return body.state;
}

export async function adoptManagedProcesses(): Promise<DashboardProcessControlState> {
    const response = await fetch('/api/dashboard/process-control/adopt', { method: 'POST' });
    if (!response.ok) throw new Error(`adopt managed failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; state: DashboardProcessControlState };
    return body.state;
}

export async function stopManagedProcesses(): Promise<DashboardProcessControlState> {
    const response = await fetch('/api/dashboard/process-control/stop-managed', { method: 'POST' });
    if (!response.ok) throw new Error(`stop managed failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; state: DashboardProcessControlState };
    return body.state;
}

export async function fetchInstanceStatus(port: number, options: { signal?: AbortSignal } = {}): Promise<DashboardInstance | null> {
    const response = await fetch(`/api/dashboard/instances/${port}`, { signal: options.signal });
    if (!response.ok) throw new Error(`status fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; instance: DashboardInstance | null };
    return body.instance;
}

export async function fetchManagerEvents(since: string | null = null): Promise<ManagerEvent[]> {
    const path = since ? `/api/manager/events?since=${encodeURIComponent(since)}` : '/api/manager/events';
    const response = await fetch(path);
    if (!response.ok) throw new Error(`events fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; events: ManagerEvent[] };
    return body.events;
}

export async function fetchHealthHistory(port: number, limit?: number): Promise<HealthEvent[]> {
    const path = limit ? `/api/manager/health-history/${port}?limit=${limit}` : `/api/manager/health-history/${port}`;
    const response = await fetch(path);
    if (!response.ok) throw new Error(`health history fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; events: HealthEvent[] };
    return body.events;
}

export async function fetchInstanceLogSnapshot(port: number): Promise<InstanceLogSnapshot> {
    const response = await fetch(`/api/manager/instance-logs/${port}`);
    if (!response.ok) throw new Error(`logs fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; snapshot: InstanceLogSnapshot };
    return body.snapshot;
}
