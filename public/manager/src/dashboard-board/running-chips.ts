import type { DragEvent } from 'react';
import type { DashboardInstance } from '../types';

export type RunningChip = {
    port: number;
    label: string;
    activity: string | null;
    state: 'busy' | 'online' | 'error';
};

export const RUNNING_CHIP_MIME = 'application/x-jaw-running-chip';

export function deriveRunningChips(
    instances: DashboardInstance[],
    titlesByPort: Record<number, string>,
    busyPorts: Set<number>,
): RunningChip[] {
    const chips: RunningChip[] = [];
    const seen = new Set<number>();
    for (const instance of instances) {
        if (instance.hidden) continue;
        const port = instance.port;
        if (seen.has(port)) continue;
        seen.add(port);
        const isBusy = busyPorts.has(port);
        const isOnline = instance.status === 'online';
        const isError = instance.status === 'error';
        if (!isBusy && !isOnline && !isError) continue;
        chips.push({
            port,
            label: instance.label || instance.instanceId || `Port ${port}`,
            activity: titlesByPort[port] || null,
            state: isBusy ? 'busy' : isError ? 'error' : 'online',
        });
    }
    return chips;
}

export function encodeRunningChip(chip: RunningChip): string {
    return JSON.stringify({
        port: chip.port,
        label: chip.label,
        activity: chip.activity,
        state: chip.state,
    });
}

export function decodeRunningChip(e: DragEvent): RunningChip | null {
    const raw = e.dataTransfer.getData(RUNNING_CHIP_MIME);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<RunningChip>;
        if (typeof parsed.port !== 'number') return null;
        return {
            port: parsed.port,
            label: typeof parsed.label === 'string' ? parsed.label : `Port ${parsed.port}`,
            activity: typeof parsed.activity === 'string' ? parsed.activity : null,
            state: parsed.state === 'busy' || parsed.state === 'error' ? parsed.state : 'online',
        };
    } catch {
        return null;
    }
}
