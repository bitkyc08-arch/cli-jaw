import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveDashboardHome } from './dashboard-home.js';

export const REGISTRY_SCHEMA_VERSION = 1;
export const MARKER_SCHEMA_VERSION = 1;
export const MARKER_FILENAME = '.dashboard-managed.json';

export type PersistedEntry = {
    schemaVersion: 1;
    managerPort: number;
    port: number;
    pid: number;
    home: string;
    startedAt: string;
    command: string[];
    token: string;
};

export type LifecycleRegistrySource = 'current' | 'legacy' | 'missing' | 'corrupt';

export type PersistedRegistry = {
    schemaVersion: 1;
    managerPort: number;
    entries: PersistedEntry[];
    source?: LifecycleRegistrySource;
    sourcePath?: string | null;
    legacyPath?: string | null;
};

export type HomeMarker = {
    schemaVersion: 1;
    managedBy: 'cli-jaw-dashboard';
    managerPort: number;
    port: number;
    pid: number;
    token: string;
    startedAt: string;
};

export type LifecycleStoreFs = {
    readFile: typeof readFile;
    writeFile: typeof writeFile;
    rename: typeof rename;
    mkdir: typeof mkdir;
    rm: typeof rm;
    existsSync: typeof existsSync;
};

export type LifecycleStoreOptions = {
    managerPort: number;
    dashboardHome?: string;
    storageRoot?: string;
    legacyStorageRoot?: string;
    fsImpl?: LifecycleStoreFs;
};

const DEFAULT_FS: LifecycleStoreFs = {
    readFile,
    writeFile,
    rename,
    mkdir,
    rm,
    existsSync,
};

export class LifecycleStore {
    private readonly managerPort: number;
    private readonly registryDir: string;
    private readonly registryPath: string;
    private readonly legacyRegistryPath: string;
    private readonly fs: LifecycleStoreFs;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(options: LifecycleStoreOptions) {
        this.managerPort = options.managerPort;
        const dashboardHome = options.dashboardHome || options.storageRoot || resolveDashboardHome();
        const legacyRoot = options.legacyStorageRoot || options.storageRoot || homedir();
        this.registryDir = join(dashboardHome, 'lifecycle', 'managers', String(options.managerPort));
        this.registryPath = join(this.registryDir, 'dashboard-managed.json');
        this.legacyRegistryPath = join(
            legacyRoot,
            `.cli-jaw-manager-${options.managerPort}`,
            'dashboard-managed.json',
        );
        this.fs = options.fsImpl || DEFAULT_FS;
    }

    static newToken(): string {
        return randomBytes(16).toString('hex');
    }

    path(): string {
        return this.registryPath;
    }

    legacyPath(): string {
        return this.legacyRegistryPath;
    }

    async load(): Promise<PersistedRegistry> {
        const empty: PersistedRegistry = {
            schemaVersion: 1,
            managerPort: this.managerPort,
            entries: [],
            source: 'missing',
            sourcePath: null,
            legacyPath: this.legacyRegistryPath,
        };
        if (this.fs.existsSync(this.registryPath)) {
            return await this.loadFromPath(this.registryPath, 'current', empty);
        }
        if (this.fs.existsSync(this.legacyRegistryPath)) {
            return await this.loadFromPath(this.legacyRegistryPath, 'legacy', empty);
        }
        return empty;
    }

    private async loadFromPath(
        path: string,
        source: LifecycleRegistrySource,
        empty: PersistedRegistry,
    ): Promise<PersistedRegistry> {
        try {
            const raw = await this.fs.readFile(path, 'utf8');
            const parsed = JSON.parse(String(raw)) as PersistedRegistry;
            if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION) return empty;
            if (parsed.managerPort !== this.managerPort) return empty;
            return {
                schemaVersion: 1,
                managerPort: this.managerPort,
                entries: Array.isArray(parsed.entries) ? parsed.entries : [],
                source,
                sourcePath: path,
                legacyPath: this.legacyRegistryPath,
            };
        } catch {
            return {
                ...empty,
                source: 'corrupt',
                sourcePath: path,
            };
        }
    }

    save(entries: PersistedEntry[]): Promise<void> {
        const next = this.writeQueue.then(() => this.writeAtomic(entries));
        this.writeQueue = next.catch(() => undefined);
        return next;
    }

    private async writeAtomic(entries: PersistedEntry[]): Promise<void> {
        await this.fs.mkdir(this.registryDir, { recursive: true });
        const tmp = `${this.registryPath}.tmp-${process.pid}`;
        const payload: PersistedRegistry = {
            schemaVersion: 1,
            managerPort: this.managerPort,
            entries,
        };
        await this.fs.writeFile(tmp, JSON.stringify(payload, null, 2));
        await this.fs.rename(tmp, this.registryPath);
    }

    async writeMarker(home: string, marker: HomeMarker): Promise<void> {
        await this.fs.mkdir(home, { recursive: true });
        const tmp = join(home, `${MARKER_FILENAME}.tmp-${process.pid}`);
        const dst = join(home, MARKER_FILENAME);
        await this.fs.writeFile(tmp, JSON.stringify(marker, null, 2));
        await this.fs.rename(tmp, dst);
    }

    async readMarker(home: string): Promise<HomeMarker | null> {
        const dst = join(home, MARKER_FILENAME);
        if (!this.fs.existsSync(dst)) return null;
        try {
            const raw = await this.fs.readFile(dst, 'utf8');
            const parsed = JSON.parse(String(raw)) as HomeMarker;
            if (parsed.schemaVersion !== MARKER_SCHEMA_VERSION) return null;
            if (parsed.managedBy !== 'cli-jaw-dashboard') return null;
            return parsed;
        } catch {
            return null;
        }
    }

    async deleteMarker(home: string): Promise<void> {
        const dst = join(home, MARKER_FILENAME);
        if (!this.fs.existsSync(dst)) return;
        await this.fs.rm(dst, { force: true });
    }
}
