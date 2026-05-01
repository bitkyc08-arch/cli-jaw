import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { DashboardServiceState, DashboardLifecycleResult } from './types.js';

export type ServiceBackend = 'launchd' | 'systemd' | 'none';

export function detectBackend(): ServiceBackend {
    if (process.platform === 'darwin') return 'launchd';
    if (process.platform === 'linux') {
        try {
            execFileSync('which', ['systemctl'], { stdio: 'pipe' });
            return 'systemd';
        } catch { return 'none'; }
    }
    return 'none';
}

const backend = detectBackend();

export function isServiceSupported(): boolean {
    return backend !== 'none';
}

export function currentBackend(): ServiceBackend {
    return backend;
}

export async function detectServiceState(port: number, home: string): Promise<DashboardServiceState> {
    if (backend === 'launchd') {
        const mod = await import('./launchd-service.js');
        return mod.detectLaunchdState(port, home);
    }
    if (backend === 'systemd') {
        const mod = await import('./systemd-service.js');
        return mod.detectSystemdState(port, home);
    }
    return { registered: false, loaded: false, pid: null, label: '', unitPath: '', backend: 'none' };
}

export async function detectAllServiceStates(
    portRange: { from: number; to: number },
    homeRoot = homedir(),
): Promise<Map<number, DashboardServiceState>> {
    if (backend === 'launchd') {
        const mod = await import('./launchd-service.js');
        return mod.detectAllLaunchdStates(portRange, homeRoot);
    }
    if (backend === 'systemd') {
        const mod = await import('./systemd-service.js');
        return mod.detectAllSystemdStates(portRange, homeRoot);
    }
    return new Map();
}

export async function permInstance(port: number, home: string): Promise<DashboardLifecycleResult> {
    if (backend === 'launchd') {
        const mod = await import('./launchd-service.js');
        return mod.permInstance(port, home);
    }
    if (backend === 'systemd') {
        const mod = await import('./systemd-service.js');
        return mod.permInstance(port, home);
    }
    return { ok: false, action: 'perm', port, status: 'rejected', message: 'no service backend available', home, pid: null, command: [] };
}

export async function unpermInstance(port: number, home: string): Promise<DashboardLifecycleResult> {
    if (backend === 'launchd') {
        const mod = await import('./launchd-service.js');
        return mod.unpermInstance(port, home);
    }
    if (backend === 'systemd') {
        const mod = await import('./systemd-service.js');
        return mod.unpermInstance(port, home);
    }
    return { ok: false, action: 'unperm', port, status: 'rejected', message: 'no service backend available', home, pid: null, command: [] };
}

export async function stopServiceInstance(label: string): Promise<DashboardLifecycleResult> {
    if (backend === 'launchd') {
        const mod = await import('./launchd-service.js');
        return mod.stopLaunchdInstance(label);
    }
    if (backend === 'systemd') {
        const mod = await import('./systemd-service.js');
        return mod.stopSystemdInstance(label);
    }
    return { ok: false, action: 'stop', port: 0, status: 'rejected', message: 'no service backend available', home: null, pid: null, command: [] };
}

export async function startServiceInstance(label: string, unitPath: string): Promise<DashboardLifecycleResult> {
    if (backend === 'launchd') {
        const mod = await import('./launchd-service.js');
        return mod.startLaunchdInstance(label, unitPath);
    }
    if (backend === 'systemd') {
        const mod = await import('./systemd-service.js');
        return mod.startSystemdInstance(label);
    }
    return { ok: false, action: 'start', port: 0, status: 'rejected', message: 'no service backend available', home: null, pid: null, command: [] };
}

export async function restartServiceInstance(label: string): Promise<DashboardLifecycleResult> {
    if (backend === 'launchd') {
        const mod = await import('./launchd-service.js');
        return mod.restartLaunchdInstance(label);
    }
    if (backend === 'systemd') {
        const mod = await import('./systemd-service.js');
        return mod.restartSystemdInstance(label);
    }
    return { ok: false, action: 'restart', port: 0, status: 'rejected', message: 'no service backend available', home: null, pid: null, command: [] };
}
