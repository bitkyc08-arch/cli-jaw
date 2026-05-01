import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
    DashboardInstance,
    DashboardLaunchdState,
    DashboardLifecycleAction,
    DashboardLifecycleCapability,
    DashboardLifecycleResult,
} from './types.js';
import { MANAGED_INSTANCE_PORT_FROM } from './constants.js';

export const START_FAILURE_GRACE_MS = 250;
export const STOP_WAIT_TIMEOUT_MS = 3000;
export const PORT_FREE_TIMEOUT_MS = 4000;
export const OUTPUT_LIMIT = 4000;
export const DETACHED_EXIT_POLL_MS = 100;

export function appendBounded(current: string, chunk: Buffer | string): string {
    const next = current + String(chunk);
    return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

export function isPositivePort(port: number): boolean {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function defaultHomeForPort(port: number, root = homedir()): string {
    if (port === MANAGED_INSTANCE_PORT_FROM) return join(root, '.cli-jaw');
    return join(root, `.cli-jaw-${port}`);
}

export function waitForChildExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs = STOP_WAIT_TIMEOUT_MS,
): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (exited: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(exited);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        child.once('exit', () => done(true));
    });
}

export function waitForStartupGrace<T extends { child: ChildProcessWithoutNullStreams }>(
    entry: T,
    timeoutMs = START_FAILURE_GRACE_MS,
): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(true), timeoutMs);
        entry.child.once('exit', () => {
            clearTimeout(timer);
            resolve(false);
        });
        entry.child.once('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

export function buildCapability(args: {
    instance: DashboardInstance;
    managed: { mode: 'attached' | 'detached'; pid: number } | null;
    launchdState?: DashboardLaunchdState | null;
    defaultHome: string;
    commandPreview: string[];
}): DashboardLifecycleCapability {
    const { instance, managed, launchdState, defaultHome, commandPreview } = args;
    if (managed) {
        const hasPlist = launchdState?.plistExists ?? false;
        return {
            owner: 'manager',
            canStart: false,
            canStop: true,
            canRestart: true,
            canPerm: false,
            canUnperm: hasPlist,
            reason: managed.mode === 'attached'
                ? 'dashboard-owned'
                : 'dashboard-owned (recovered)',
            defaultHome,
            commandPreview,
            pid: managed.pid || null,
        };
    }
    if (launchdState?.plistExists) {
        if (launchdState.loaded) {
            return {
                owner: 'launchd',
                canStart: false,
                canStop: true,
                canRestart: true,
                canPerm: false,
                canUnperm: true,
                reason: 'launchd service',
                defaultHome,
                commandPreview,
                pid: launchdState.pid,
            };
        }
        return {
            owner: 'launchd',
            canStart: true,
            canStop: false,
            canRestart: false,
            canPerm: false,
            canUnperm: true,
            reason: 'launchd paused',
            defaultHome,
            commandPreview,
            pid: null,
        };
    }
    if (instance.status === 'offline') {
        return {
            owner: 'none',
            canStart: true,
            canStop: false,
            canRestart: false,
            canPerm: true,
            canUnperm: false,
            reason: 'free port',
            defaultHome,
            commandPreview,
            pid: null,
        };
    }
    return {
        owner: 'external',
        canStart: false,
        canStop: false,
        canRestart: false,
        canPerm: false,
        canUnperm: false,
        reason: 'not dashboard-owned',
        defaultHome,
        commandPreview,
        pid: null,
    };
}

export function rejectResult(
    action: DashboardLifecycleAction,
    port: number,
    home: string | null,
    command: string[],
    message: string,
): DashboardLifecycleResult {
    return {
        ok: false,
        action,
        port,
        status: 'rejected',
        message,
        home,
        pid: null,
        command,
    };
}

export function errorResultBuilder(
    action: DashboardLifecycleAction,
    port: number,
    home: string,
    command: string[],
    error: unknown,
    entry?: { pid?: number; stdout?: string; stderr?: string },
): DashboardLifecycleResult {
    return {
        ok: false,
        action,
        port,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        home,
        pid: entry?.pid || null,
        command,
        stdout: entry?.stdout,
        stderr: entry?.stderr,
    };
}
