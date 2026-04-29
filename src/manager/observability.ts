/**
 * 10.7.1 — Manager event bus.
 *
 * In-process ring buffer of recent ManagerEvents consumed by the
 * `/api/manager/events` endpoint and the frontend ActivityTimeline.
 * No subscribers, no streaming — clients pull with `?since=<iso>` cursor.
 */

import type { DashboardInstanceStatus, DashboardLifecycleAction } from './types.js';

const DEFAULT_RETENTION = 200;

export type ManagerEvent =
    | { kind: 'scan-completed'; from: number; to: number; reachable: number; at: string }
    | { kind: 'scan-failed'; reason: string; at: string }
    | { kind: 'instance-message'; port: number; messageId: number; role: string; at: string }
    | { kind: 'lifecycle-result'; port: number; action: DashboardLifecycleAction; status: string; message: string; at: string }
    | { kind: 'health-changed'; port: number; from: DashboardInstanceStatus; to: DashboardInstanceStatus; reason: string | null; at: string }
    | { kind: 'version-mismatch'; port: number; expected: string | null; seen: string; at: string }
    | { kind: 'port-collision'; port: number; pids: number[]; at: string };

export type Observability = {
    publish(event: ManagerEvent): void;
    drain(since?: string | null): ManagerEvent[];
    snapshot(): ManagerEvent[];
    clear(): void;
};

export type ObservabilityOptions = {
    retention?: number;
};

export function createObservability(options: ObservabilityOptions = {}): Observability {
    const retention = Math.max(1, options.retention ?? DEFAULT_RETENTION);
    const buffer: ManagerEvent[] = [];

    function publish(event: ManagerEvent): void {
        buffer.push(event);
        while (buffer.length > retention) buffer.shift();
    }

    function drain(since?: string | null): ManagerEvent[] {
        if (!since) return [...buffer];
        const cursor = Date.parse(since);
        if (Number.isNaN(cursor)) return [];
        return buffer.filter(event => Date.parse(event.at) > cursor);
    }

    function snapshot(): ManagerEvent[] {
        return [...buffer];
    }

    function clear(): void {
        buffer.length = 0;
    }

    return { publish, drain, snapshot, clear };
}
