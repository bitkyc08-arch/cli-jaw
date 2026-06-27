import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { getJawPath } from '../core/instance.js';
import { stripUndefined } from '../core/strip-undefined.js';
import type {
    DashboardInstance,
    DashboardServiceState,
    DashboardLifecycleAction,
    DashboardLifecycleCapability,
    DashboardLifecycleResult,
    DashboardProcessControlState,
    DashboardScanResult,
} from './types.js';
import {
    LifecycleStore,
    type PersistedEntry,
} from './lifecycle-store.js';
import {
    defaultProcessVerify,
    waitForPortFree,
    type ProcessVerifyImpl,
} from './process-verify.js';
import {
    DASHBOARD_DEFAULT_PORT,
    DASHBOARD_FALLBACK_PORT_END,
    MANAGED_INSTANCE_PORT_FROM,
    MANAGED_INSTANCE_PORT_TO,
} from './constants.js';
import {
    DETACHED_EXIT_POLL_MS,
    PORT_FREE_TIMEOUT_MS,
    STOP_WAIT_TIMEOUT_MS,
    appendBounded,
    buildCapability,
    defaultHomeForPort,
    errorResultBuilder,
    isPositivePort,
    rejectResult,
    waitForChildExit,
    waitForStartupGrace,
} from './lifecycle-helpers.js';

type ManagedProcessBase = {
    port: number;
    home: string;
    pid: number;
    startedAt: string;
    command: string[];
    token: string;
    stdout: string;
    stderr: string;
    exited: boolean;
};

type AttachedManagedProcess = ManagedProcessBase & {
    mode: 'attached';
    child: ChildProcessWithoutNullStreams;
};

type DetachedManagedProcess = ManagedProcessBase & {
    mode: 'detached';
};

type ManagedProcess = AttachedManagedProcess | DetachedManagedProcess;

export type DashboardLifecycleManagerOptions = {
    managerPort: number;
    from: number;
    count: number;
    jawPath?: string;
    homeRoot?: string;
    dashboardHome?: string;
    storageRoot?: string;
    legacyStorageRoot?: string;
    spawnImpl?: typeof spawn;
    processVerify?: Partial<ProcessVerifyImpl>;
};

export class DashboardLifecycleManager {
    private readonly managerPort: number;
    private readonly from: number;
    private readonly to: number;
    private readonly jawPath: string;
    private readonly homeRoot: string;
    private readonly spawnImpl: typeof spawn;
    private readonly verify: ProcessVerifyImpl;
    private readonly store: LifecycleStore;
    private readonly registry = new Map<number, ManagedProcess>();
    private readonly locks = new Map<number, Promise<unknown>>();

    constructor(options: DashboardLifecycleManagerOptions) {
        this.managerPort = options.managerPort;
        this.from = options.from;
        this.to = options.from + options.count - 1;
        this.jawPath = options.jawPath || getJawPath();
        this.homeRoot = options.homeRoot || homedir();
        this.spawnImpl = options.spawnImpl || spawn;
        this.verify = { ...defaultProcessVerify, ...(options.processVerify || {}) };
        this.store = new LifecycleStore(stripUndefined({
            managerPort: options.managerPort,
            dashboardHome: options.dashboardHome,
            storageRoot: options.storageRoot,
            legacyStorageRoot: options.legacyStorageRoot,
        }));
    }

    defaultHome(port: number): string {
        return defaultHomeForPort(port, this.homeRoot);
    }

    buildStartCommand(port: number, home = this.defaultHome(port)): string[] {
        return [this.jawPath, '--home', home, 'serve', '--port', String(port), '--no-open'];
    }

    decorateScanResult(result: DashboardScanResult, serviceStates?: Map<number, DashboardServiceState>): DashboardScanResult {
        const decorated = result.instances.map((instance) => {
            if (instance.status === 'offline') {
                const stale = this.registry.get(instance.port);
                if (stale && stale.mode === 'detached') {
                    this.registry.delete(instance.port);
                    void this.persistRegistry().catch(() => undefined);
                    void this.store.deleteMarker(stale.home).catch(() => undefined);
                }
            }
            return this.decorateInstance(instance, serviceStates?.get(instance.port));
        });
        return { ...result, instances: decorated };
    }

    decorateInstance(instance: DashboardInstance, serviceState?: DashboardServiceState | null, isPeer = false): DashboardInstance {
        const managed = this.activeEntry(instance.port);
        return {
            ...instance,
            serviceMode: isPeer ? 'manager' : (managed ? 'manager' : (serviceState?.loaded ? 'service' : instance.serviceMode)),
            lifecycle: this.capabilityFor(instance, managed, serviceState, isPeer),
        };
    }

    async hydrate(): Promise<{ adopted: number; pruned: number }> {
        const persisted = await this.store.load();
        const survivors: PersistedEntry[] = [];
        let adopted = 0;
        let pruned = 0;
        for (const entry of persisted.entries) {
            if (!(await this.validatePersistedEntry(entry))) {
                pruned += 1;
                continue;
            }
            this.registry.set(entry.port, {
                mode: 'detached',
                port: entry.port,
                home: entry.home,
                pid: entry.pid,
                startedAt: entry.startedAt,
                command: entry.command,
                token: entry.token,
                stdout: '',
                stderr: '',
                exited: false,
            });
            survivors.push(entry);
            adopted += 1;
        }
        if (pruned > 0 || persisted.source === 'legacy') await this.store.save(survivors);
        return { adopted, pruned };
    }

    async start(port: number, customHome?: string, serviceState?: DashboardServiceState | null): Promise<DashboardLifecycleResult> {
        return this.withLock(port, () => this.startLocked(port, customHome, serviceState));
    }

    async stop(port: number, serviceState?: DashboardServiceState | null): Promise<DashboardLifecycleResult> {
        return this.withLock(port, () => this.stopLocked(port, serviceState));
    }

    async restart(port: number, serviceState?: DashboardServiceState | null): Promise<DashboardLifecycleResult> {
        return this.withLock(port, () => this.restartLocked(port, serviceState));
    }

    async perm(port: number, home?: string): Promise<DashboardLifecycleResult> {
        const { permInstance } = await import('./platform-service.js');
        return permInstance(port, home || this.defaultHome(port));
    }

    async unperm(port: number, home?: string): Promise<DashboardLifecycleResult> {
        const { unpermInstance } = await import('./platform-service.js');
        return unpermInstance(port, home || this.defaultHome(port));
    }

    async stopAll(mode: 'full' | 'locked-skip' = 'locked-skip'): Promise<DashboardLifecycleResult[]> {
        const ports = [...this.registry.keys()];
        const results: DashboardLifecycleResult[] = [];
        for (const port of ports) {
            if (!this.registry.has(port)) continue;
            if (mode === 'locked-skip') {
                const entry = this.registry.get(port)!;
                try {
                    const marker = await this.store.readMarker(entry.home);
                    if (marker?.protected) {
                        results.push({
                            ok: true,
                            action: 'stop',
                            status: 'skipped',
                            message: `Skipped port ${port}: instance is protected.`,
                            port,
                            home: entry.home,
                            pid: entry.pid || null,
                            command: entry.command,
                            expectedStateAfter: 'online',
                        });
                        continue;
                    }
                } catch {
                    // Marker read failed — treat as unprotected, proceed with stop.
                }
            }
            results.push(await this.stop(port));
        }
        return results;
    }

    async protectInstance(port: number): Promise<boolean> {
        const entry = this.registry.get(port);
        if (!entry || entry.exited) return false;
        const marker = await this.store.readMarker(entry.home);
        if (!marker) return false;
        await this.store.writeMarker(entry.home, { ...marker, protected: true });
        return true;
    }

    async unprotectInstance(port: number): Promise<boolean> {
        const entry = this.registry.get(port);
        if (!entry || entry.exited) return false;
        const marker = await this.store.readMarker(entry.home);
        if (!marker) return false;
        const { protected: _p, ...rest } = marker;
        await this.store.writeMarker(entry.home, rest as typeof marker);
        return true;
    }

    processControlState(): DashboardProcessControlState {
        const managed = [...this.registry.values()]
            .filter(entry => !entry.exited)
            .map(entry => ({
                port: entry.port, pid: entry.pid || null, home: entry.home,
                proof: entry.mode === 'attached' ? 'child' as const : 'registry' as const,
                canStop: true, canForceRelease: false,
                reason: entry.mode === 'attached' ? 'Dashboard-owned child process.' : 'Recovered from dashboard lifecycle registry.',
            }))
            .sort((a, b) => a.port - b.port);
        return {
            managed,
            unsupported: { dashboardService: true, forceRelease: true, reason: 'Force release is planned but disabled until strict command/home ownership proof is implemented.' },
        };
    }

    private async validatePersistedEntry(entry: PersistedEntry): Promise<boolean> {
        if (!isPositivePort(entry.port)) return false;
        if (entry.port < this.from || entry.port > this.to) return false;
        if (!Number.isInteger(entry.pid) || entry.pid <= 0) return false;
        if (!this.verify.isPidAlive(entry.pid)) return false;
        const owningPid = await this.verify.resolveListeningPid(entry.port);
        if (owningPid !== entry.pid) return false;
        const marker = await this.store.readMarker(entry.home);
        if (!marker) return false;
        if (marker.token !== entry.token) return false;
        if (marker.pid !== entry.pid) return false;
        if (marker.port !== entry.port) return false;
        if (marker.managerPort !== this.managerPort) return false;
        return true;
    }

    private async startLocked(
        port: number,
        customHome?: string,
        serviceState?: DashboardServiceState | null,
    ): Promise<DashboardLifecycleResult> {
        const action: DashboardLifecycleAction = 'start';
        const home = customHome?.trim() || this.defaultHome(port);
        const command = this.buildStartCommand(port, home);
        const rejected = this.validatePort(action, port, home, command);
        if (rejected) return rejected;
        if (this.activeEntry(port)) {
            return rejectResult(action, port, home, command, 'Port is already manager-owned.');
        }
        if (serviceState?.loaded) {
            return rejectResult(action, port, home, command, 'Port is managed by a system service. Unperm first.');
        }
        if (await this.verify.isPortOccupied(port)) {
            return rejectResult(action, port, home, command, 'Port is already occupied.');
        }

        try {
            const child = this.spawnImpl(command[0]!, command.slice(1), {
                // P2b: instances in hub-member mode relay outbound to the dashboard hub.
                env: { ...process.env, JAW_HUB_CALLBACK_URL: `http://127.0.0.1:${DASHBOARD_DEFAULT_PORT}` },
                stdio: 'pipe',
            }) as ChildProcessWithoutNullStreams;
            const token = LifecycleStore.newToken();
            const attached: AttachedManagedProcess = {
                mode: 'attached',
                port,
                home,
                pid: child.pid || 0,
                startedAt: new Date().toISOString(),
                command,
                token,
                child,
                stdout: '',
                stderr: '',
                exited: false,
            };
            child.stdout.on('data', (chunk) => {
                attached.stdout = appendBounded(attached.stdout, chunk);
            });
            child.stderr.on('data', (chunk) => {
                attached.stderr = appendBounded(attached.stderr, chunk);
            });
            child.once('exit', () => {
                attached.exited = true;
                if (this.registry.get(port) === attached) {
                    this.registry.delete(port);
                    void this.persistRegistry().catch(() => undefined);
                    void this.store.deleteMarker(attached.home).catch(() => undefined);
                }
            });
            child.once('error', (error) => {
                attached.exited = true;
                attached.stderr = appendBounded(attached.stderr, error.message);
                if (this.registry.get(port) === attached) {
                    this.registry.delete(port);
                    void this.persistRegistry().catch(() => undefined);
                    void this.store.deleteMarker(attached.home).catch(() => undefined);
                }
            });
            this.registry.set(port, attached);
            await this.persistRegistry();
            await this.store.writeMarker(attached.home, {
                schemaVersion: 1,
                managedBy: 'cli-jaw-dashboard',
                managerPort: this.managerPort,
                port,
                pid: attached.pid,
                token,
                startedAt: attached.startedAt,
            });

            // The child may have already emitted 'error'/'exit' during the awaited
            // persist+marker writes — handlers consume those events and waitForStartupGrace
            // would never see them. Also: writeMarker may have re-written a file that the
            // exit handler already deleted, so we must re-clean here regardless.
            const sweepFailedSpawn = async (): Promise<void> => {
                if (this.registry.get(port) === attached) {
                    this.registry.delete(port);
                }
                await this.persistRegistry();
                await this.store.deleteMarker(attached.home);
            };

            if (attached.exited) {
                await sweepFailedSpawn();
                return errorResultBuilder(
                    action, port, home, command,
                    new Error(attached.stderr || 'Process exited before startup completed.'),
                    attached,
                );
            }

            const stillRunning = await waitForStartupGrace(attached);
            if (!stillRunning) {
                await sweepFailedSpawn();
                return errorResultBuilder(
                    action, port, home, command,
                    new Error(attached.stderr || 'Process exited before startup completed.'),
                    attached,
                );
            }
            return {
                ok: true, action, port,
                status: 'started',
                message: `Started Jaw on port ${port}.`,
                home,
                pid: attached.pid || null,
                command,
                expectedStateAfter: 'online',
            };
        } catch (error) {
            return errorResultBuilder(action, port, home, command, error);
        }
    }

    private async stopLocked(port: number, serviceState?: DashboardServiceState | null): Promise<DashboardLifecycleResult> {
        const action: DashboardLifecycleAction = 'stop';
        const entry = this.activeEntry(port);
        const home = entry?.home || this.defaultHome(port);
        const command = entry?.command || this.buildStartCommand(port, home);
        const rejected = this.validatePort(action, port, home, command);
        if (rejected) return rejected;
        if (!entry && serviceState?.registered) {
            const { unpermInstance } = await import('./platform-service.js');
            const result = await unpermInstance(port, home);
            return { ...result, action: 'stop', status: result.ok ? 'stopped' : result.status, port, home, expectedStateAfter: 'offline' };
        }
        if (!entry && this.isDashboardPort(port)) {
            return this.stopPeerDashboard(port, home, command);
        }
        if (!entry) {
            return this.stopExternalCoreInstance(port, home, command);
        }

        try {
            await this.signal(entry, 'SIGTERM');
            const exited = await this.waitForEntryExit(entry, STOP_WAIT_TIMEOUT_MS);
            if (!exited) {
                if (await this.stillSameOwner(entry)) {
                    await this.signal(entry, 'SIGKILL');
                    await this.waitForEntryExit(entry, STOP_WAIT_TIMEOUT_MS);
                } else {
                    this.registry.delete(port);
                    await this.persistRegistry();
                    await this.store.deleteMarker(entry.home);
                    return {
                        ok: true, action, port, status: 'stopped',
                        message: `Stopped (port ${port} ownership changed during stop).`,
                        home: entry.home, pid: entry.pid || null, command: entry.command,
                        expectedStateAfter: 'offline',
                    };
                }
            }
            await waitForPortFree(port, PORT_FREE_TIMEOUT_MS, {
                isPortOccupied: this.verify.isPortOccupied,
            });
            this.registry.delete(port);
            await this.persistRegistry();
            await this.store.deleteMarker(entry.home);
            return {
                ok: true, action, port, status: 'stopped',
                message: `Stopped dashboard-owned Jaw on port ${port}.`,
                home: entry.home, pid: entry.pid || null, command: entry.command,
                expectedStateAfter: 'offline',
                stdout: entry.stdout, stderr: entry.stderr,
            };
        } catch (error) {
            return errorResultBuilder(action, port, home, command, error, entry);
        }
    }

    private async restartLocked(port: number, serviceState?: DashboardServiceState | null): Promise<DashboardLifecycleResult> {
        const action: DashboardLifecycleAction = 'restart';
        const entry = this.activeEntry(port);
        const home = entry?.home || this.defaultHome(port);
        const command = entry?.command || this.buildStartCommand(port, home);
        const rejected = this.validatePort(action, port, home, command);
        if (rejected) return rejected;
        if (!entry && serviceState?.loaded) {
            const { restartServiceInstance } = await import('./platform-service.js');
            const result = await restartServiceInstance(serviceState.label);
            return { ...result, port, home, expectedStateAfter: 'restart-detected' };
        }
        if (!entry) {
            return rejectResult(action, port, home, command, 'Only dashboard-owned instances can be restarted.');
        }

        const stopResult = await this.stopLocked(port);
        if (!stopResult.ok) return { ...stopResult, action };
        const startResult = await this.startLocked(port, home);
        return stripUndefined({
            ...startResult,
            action,
            status: startResult.ok ? 'restarted' : startResult.status,
            message: startResult.ok
                ? `Restarted dashboard-owned Jaw on port ${port}.`
                : startResult.message,
            expectedStateAfter: startResult.ok ? 'restart-detected' : startResult.expectedStateAfter,
        });
    }

    private withLock<T>(port: number, fn: () => Promise<T>): Promise<T> {
        const prev = this.locks.get(port) || Promise.resolve();
        const next = prev.then(fn, fn);
        this.locks.set(port, next.catch(() => undefined));
        return next;
    }

    private async signal(entry: ManagedProcess, sig: NodeJS.Signals): Promise<void> {
        if (entry.mode === 'attached') {
            entry.child.kill(sig);
            return;
        }
        if (this.verify.isPidAlive(entry.pid)) {
            try {
                this.verify.killPid(entry.pid, sig);
            } catch {
                // PID disappeared between alive-check and signal — treat as already exited.
            }
        }
    }

    private waitForEntryExit(entry: ManagedProcess, timeoutMs: number): Promise<boolean> {
        if (entry.mode === 'attached') return waitForChildExit(entry.child, timeoutMs);
        return new Promise<boolean>((resolve) => {
            const start = Date.now();
            const check = (): void => {
                if (!this.verify.isPidAlive(entry.pid)) {
                    entry.exited = true;
                    resolve(true);
                    return;
                }
                if (Date.now() - start >= timeoutMs) { resolve(false); return; }
                setTimeout(check, DETACHED_EXIT_POLL_MS);
            };
            check();
        });
    }

    private async stillSameOwner(entry: ManagedProcess): Promise<boolean> {
        if (!this.verify.isPidAlive(entry.pid)) return false;
        const owning = await this.verify.resolveListeningPid(entry.port);
        return owning === entry.pid;
    }

    private activeEntry(port: number): ManagedProcess | null {
        const entry = this.registry.get(port);
        if (!entry || entry.exited) return null;
        if (entry.mode === 'detached' && !this.verify.isPidAlive(entry.pid)) {
            entry.exited = true;
            this.registry.delete(port);
            void this.persistRegistry().catch(() => undefined);
            void this.store.deleteMarker(entry.home).catch(() => undefined);
            return null;
        }
        return entry;
    }

    private capabilityFor(
        instance: DashboardInstance,
        managed: ManagedProcess | null,
        serviceState?: DashboardServiceState | null,
        isPeer = false,
    ): DashboardLifecycleCapability {
        return buildCapability(stripUndefined({
            instance,
            managed: managed ? { mode: managed.mode, pid: managed.pid } : null,
            serviceState,
            defaultHome: this.defaultHome(instance.port),
            commandPreview: this.buildStartCommand(instance.port, this.defaultHome(instance.port)),
            isPeer,
        }));
    }

    private async persistRegistry(): Promise<void> {
        const entries: PersistedEntry[] = [];
        for (const e of this.registry.values()) {
            if (e.exited) continue;
            entries.push({
                schemaVersion: 1,
                managerPort: this.managerPort,
                port: e.port,
                pid: e.pid,
                home: e.home,
                startedAt: e.startedAt,
                command: e.command,
                token: e.token,
            });
        }
        await this.store.save(entries);
    }

    isDashboardPort(port: number): boolean {
        const dashDefault = Number(DASHBOARD_DEFAULT_PORT);
        return port >= dashDefault && port <= DASHBOARD_FALLBACK_PORT_END;
    }

    private validatePort(
        action: DashboardLifecycleAction,
        port: number,
        home: string,
        command: string[],
    ): DashboardLifecycleResult | null {
        if (!isPositivePort(port)) return rejectResult(action, port, home, command, 'Invalid port.');
        if (port === this.managerPort) {
            return rejectResult(action, port, home, command, 'Cannot perform lifecycle action on self.');
        }
        // Allow stop on peer dashboard ports (24576-24590)
        if (action === 'stop' && this.isDashboardPort(port)) {
            return null;
        }
        if (port < this.from || port > this.to) {
            return rejectResult(
                action, port, home, command,
                `Port ${port} is outside dashboard scan range ${this.from}-${this.to}.`,
            );
        }
        return null;
    }

    private async stopPeerDashboard(port: number, home: string, command: string[]): Promise<DashboardLifecycleResult> {
        const action: DashboardLifecycleAction = 'stop';
        const pid = await this.verify.resolveListeningPid(port);
        if (!pid) {
            return rejectResult(action, port, home, command, 'Peer dashboard is not running or PID not found.');
        }
        try {
            this.verify.killPid(pid, 'SIGTERM');
            const freed = await waitForPortFree(port, STOP_WAIT_TIMEOUT_MS, this.verify);
            if (!freed && this.verify.isPidAlive(pid)) {
                this.verify.killPid(pid, 'SIGKILL');
                await waitForPortFree(port, STOP_WAIT_TIMEOUT_MS, this.verify);
            }
            return {
                ok: true,
                action,
                status: 'stopped',
                port,
                home,
                command,
                pid,
                message: `Peer dashboard on port ${port} stopped (pid ${pid}).`,
                expectedStateAfter: 'offline',
            };
        } catch (error) {
            return errorResultBuilder(action, port, home, command, error);
        }
    }

    private async stopExternalCoreInstance(port: number, home: string, command: string[]): Promise<DashboardLifecycleResult> {
        const action: DashboardLifecycleAction = 'stop';
        if (port < MANAGED_INSTANCE_PORT_FROM || port > MANAGED_INSTANCE_PORT_TO) {
            return rejectResult(
                action,
                port,
                home,
                command,
                `External stop is limited to core instance ports ${MANAGED_INSTANCE_PORT_FROM}-${MANAGED_INSTANCE_PORT_TO}.`,
            );
        }
        const pid = await this.verify.resolveListeningPid(port);
        if (!pid) {
            return rejectResult(action, port, home, command, 'External instance is not running or listener PID not found.');
        }
        try {
            this.verify.killPid(pid, 'SIGTERM');
            const freed = await waitForPortFree(port, STOP_WAIT_TIMEOUT_MS, this.verify);
            if (!freed && this.verify.isPidAlive(pid)) {
                this.verify.killPid(pid, 'SIGKILL');
                await waitForPortFree(port, STOP_WAIT_TIMEOUT_MS, this.verify);
            }
            return {
                ok: true,
                action,
                status: 'stopped',
                port,
                home,
                command,
                pid,
                message: `External Jaw on port ${port} stopped by listener PID ${pid}.`,
                expectedStateAfter: 'offline',
            };
        } catch (error) {
            return errorResultBuilder(action, port, home, command, error);
        }
    }
}
