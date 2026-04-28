import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getJawPath } from '../core/instance.js';
import { MANAGED_INSTANCE_HOST } from './constants.js';
import type {
    DashboardInstance,
    DashboardLifecycleAction,
    DashboardLifecycleCapability,
    DashboardLifecycleResult,
    DashboardScanResult,
} from './types.js';

const DEFAULT_PORT_CHECK_TIMEOUT_MS = 300;
const START_FAILURE_GRACE_MS = 250;
const STOP_WAIT_TIMEOUT_MS = 3000;
const OUTPUT_LIMIT = 4000;

type ManagedProcess = {
    port: number;
    home: string;
    pid: number;
    startedAt: string;
    command: string[];
    child: ChildProcessWithoutNullStreams;
    stdout: string;
    stderr: string;
    exited: boolean;
};

export type DashboardLifecycleManagerOptions = {
    from: number;
    count: number;
    jawPath?: string;
    homeRoot?: string;
    spawnImpl?: typeof spawn;
    isPortOccupied?: (port: number) => Promise<boolean>;
};

function appendBounded(current: string, chunk: Buffer | string): string {
    const next = current + String(chunk);
    return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

function isPositivePort(port: number): boolean {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}

function defaultHomeForPort(port: number, root = homedir()): string {
    return join(root, `.cli-jaw-${port}`);
}

async function defaultPortOccupied(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const socket = new Socket();
        let settled = false;
        const finish = (occupied: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(occupied);
        };
        socket.setTimeout(DEFAULT_PORT_CHECK_TIMEOUT_MS);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, MANAGED_INSTANCE_HOST);
    });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = STOP_WAIT_TIMEOUT_MS): Promise<boolean> {
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

function waitForStartupGrace(entry: ManagedProcess, timeoutMs = START_FAILURE_GRACE_MS): Promise<boolean> {
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

export class DashboardLifecycleManager {
    private readonly from: number;
    private readonly to: number;
    private readonly jawPath: string;
    private readonly homeRoot: string;
    private readonly spawnImpl: typeof spawn;
    private readonly isPortOccupied: (port: number) => Promise<boolean>;
    private readonly registry = new Map<number, ManagedProcess>();

    constructor(options: DashboardLifecycleManagerOptions) {
        this.from = options.from;
        this.to = options.from + options.count - 1;
        this.jawPath = options.jawPath || getJawPath();
        this.homeRoot = options.homeRoot || homedir();
        this.spawnImpl = options.spawnImpl || spawn;
        this.isPortOccupied = options.isPortOccupied || defaultPortOccupied;
    }

    defaultHome(port: number): string {
        return defaultHomeForPort(port, this.homeRoot);
    }

    buildStartCommand(port: number, home = this.defaultHome(port)): string[] {
        return [
            this.jawPath,
            '--home',
            home,
            'serve',
            '--port',
            String(port),
            '--no-open',
        ];
    }

    decorateScanResult(result: DashboardScanResult): DashboardScanResult {
        return {
            ...result,
            instances: result.instances.map(instance => this.decorateInstance(instance)),
        };
    }

    decorateInstance(instance: DashboardInstance): DashboardInstance {
        const managed = this.activeEntry(instance.port);
        const lifecycle = this.capabilityFor(instance, managed);
        return {
            ...instance,
            serviceMode: managed ? 'manager' : instance.serviceMode,
            lifecycle,
        };
    }

    async start(port: number, customHome?: string): Promise<DashboardLifecycleResult> {
        const action: DashboardLifecycleAction = 'start';
        const home = customHome?.trim() || this.defaultHome(port);
        const command = this.buildStartCommand(port, home);
        const rejected = this.validatePort(action, port, home, command);
        if (rejected) return rejected;
        if (this.activeEntry(port)) {
            return this.reject(action, port, home, command, 'Port is already manager-owned.');
        }
        if (await this.isPortOccupied(port)) {
            return this.reject(action, port, home, command, 'Port is already occupied.');
        }

        try {
            const child = this.spawnImpl(command[0]!, command.slice(1), {
                env: process.env,
                stdio: 'pipe',
            }) as ChildProcessWithoutNullStreams;
            const entry: ManagedProcess = {
                port,
                home,
                pid: child.pid || 0,
                startedAt: new Date().toISOString(),
                command,
                child,
                stdout: '',
                stderr: '',
                exited: false,
            };
            child.stdout.on('data', chunk => { entry.stdout = appendBounded(entry.stdout, chunk); });
            child.stderr.on('data', chunk => { entry.stderr = appendBounded(entry.stderr, chunk); });
            child.once('exit', () => {
                entry.exited = true;
                if (this.registry.get(port) === entry) this.registry.delete(port);
            });
            child.once('error', error => {
                entry.exited = true;
                entry.stderr = appendBounded(entry.stderr, error.message);
                if (this.registry.get(port) === entry) this.registry.delete(port);
            });
            this.registry.set(port, entry);
            const stillRunning = await waitForStartupGrace(entry);
            if (!stillRunning) {
                return this.errorResult(action, port, home, command, new Error(entry.stderr || 'Process exited before startup completed.'), entry);
            }
            return {
                ok: true,
                action,
                port,
                status: 'started',
                message: `Started Jaw on port ${port}.`,
                home,
                pid: entry.pid || null,
                command,
                expectedStateAfter: 'online',
            };
        } catch (error) {
            return this.errorResult(action, port, home, command, error);
        }
    }

    async stop(port: number): Promise<DashboardLifecycleResult> {
        const action: DashboardLifecycleAction = 'stop';
        const entry = this.activeEntry(port);
        const home = entry?.home || this.defaultHome(port);
        const command = entry?.command || this.buildStartCommand(port, home);
        const rejected = this.validatePort(action, port, home, command);
        if (rejected) return rejected;
        if (!entry) {
            return this.reject(action, port, home, command, 'Only dashboard-owned instances can be stopped.');
        }

        try {
            entry.child.kill('SIGTERM');
            const exited = await waitForExit(entry.child);
            if (!exited) {
                entry.stderr = appendBounded(entry.stderr, `Timed out waiting for port ${port} to stop.`);
                return this.errorResult(action, port, home, command, new Error('Timed out waiting for process exit.'), entry);
            }
            this.registry.delete(port);
            return {
                ok: true,
                action,
                port,
                status: 'stopped',
                message: `Stopped dashboard-owned Jaw on port ${port}.`,
                home,
                pid: entry.pid || null,
                command,
                expectedStateAfter: 'offline',
                stdout: entry.stdout,
                stderr: entry.stderr,
            };
        } catch (error) {
            return this.errorResult(action, port, home, command, error, entry);
        }
    }

    async stopAll(): Promise<DashboardLifecycleResult[]> {
        const entries = [...this.registry.entries()];
        const results: DashboardLifecycleResult[] = [];
        for (const [managedPort] of entries) {
            if (!this.activeEntry(managedPort)) continue;
            results.push(await this.stop(managedPort));
        }
        return results;
    }

    async restart(port: number): Promise<DashboardLifecycleResult> {
        const action: DashboardLifecycleAction = 'restart';
        const entry = this.activeEntry(port);
        const home = entry?.home || this.defaultHome(port);
        const command = entry?.command || this.buildStartCommand(port, home);
        const rejected = this.validatePort(action, port, home, command);
        if (rejected) return rejected;
        if (!entry) {
            return this.reject(action, port, home, command, 'Only dashboard-owned instances can be restarted.');
        }

        const stopResult = await this.stop(port);
        if (!stopResult.ok) return { ...stopResult, action };
        const startResult = await this.start(port, home);
        return {
            ...startResult,
            action,
            status: startResult.ok ? 'restarted' : startResult.status,
            message: startResult.ok
                ? `Restarted dashboard-owned Jaw on port ${port}.`
                : startResult.message,
            expectedStateAfter: startResult.ok ? 'restart-detected' : startResult.expectedStateAfter,
        };
    }

    private activeEntry(port: number): ManagedProcess | null {
        const entry = this.registry.get(port);
        return entry && !entry.exited ? entry : null;
    }

    private capabilityFor(instance: DashboardInstance, managed: ManagedProcess | null): DashboardLifecycleCapability {
        const defaultHome = this.defaultHome(instance.port);
        const commandPreview = this.buildStartCommand(instance.port, defaultHome);
        if (managed) {
            return {
                owner: 'manager',
                canStart: false,
                canStop: true,
                canRestart: true,
                reason: 'dashboard-owned',
                defaultHome,
                commandPreview,
                pid: managed.pid || null,
            };
        }
        if (instance.status === 'offline') {
            return {
                owner: 'none',
                canStart: true,
                canStop: false,
                canRestart: false,
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
            reason: 'not dashboard-owned',
            defaultHome,
            commandPreview,
            pid: null,
        };
    }

    private validatePort(
        action: DashboardLifecycleAction,
        port: number,
        home: string,
        command: string[],
    ): DashboardLifecycleResult | null {
        if (!isPositivePort(port)) return this.reject(action, port, home, command, 'Invalid port.');
        if (port < this.from || port > this.to) {
            return this.reject(action, port, home, command, `Port ${port} is outside dashboard scan range ${this.from}-${this.to}.`);
        }
        return null;
    }

    private reject(
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

    private errorResult(
        action: DashboardLifecycleAction,
        port: number,
        home: string,
        command: string[],
        error: unknown,
        entry?: ManagedProcess,
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
}
