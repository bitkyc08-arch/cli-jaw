import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
    MANAGED_INSTANCE_PORT_COUNT,
    MANAGED_INSTANCE_PORT_FROM,
} from './constants.js';
import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardRegistry,
    DashboardRegistryInstance,
    DashboardRegistryPatch,
    DashboardRegistryStatus,
    DashboardRegistryUi,
    DashboardScanResult,
    DashboardUiTheme,
} from './types.js';

const REGISTRY_FILE = 'manager-instances.json';
const MIN_ACTIVITY_HEIGHT = 88;
const MAX_ACTIVITY_HEIGHT = 320;
const DEFAULT_ACTIVITY_HEIGHT = 150;
const DETAIL_TABS: DashboardDetailTab[] = ['overview', 'preview', 'logs', 'settings'];
const UI_THEMES: DashboardUiTheme[] = ['auto', 'dark', 'light'];

export type DashboardRegistryLoadResult = {
    registry: DashboardRegistry;
    status: DashboardRegistryStatus;
};

type RegistryOptions = {
    path?: string;
    from?: number;
    count?: number;
};

type ApplyOptions = {
    showHidden?: boolean;
};

function managerHome(): string {
    const home = process.env.CLI_JAW_HOME || join(homedir(), '.cli-jaw');
    return resolve(home.replace(/^~(?=\/|$)/, homedir()));
}

export function dashboardRegistryPath(): string {
    return join(managerHome(), REGISTRY_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function validInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
}

function defaultUi(): DashboardRegistryUi {
    return {
        selectedPort: null,
        selectedTab: 'overview',
        sidebarCollapsed: false,
        activityDockCollapsed: false,
        activityDockHeight: DEFAULT_ACTIVITY_HEIGHT,
        uiTheme: 'auto',
    };
}

export function defaultDashboardRegistry(options: RegistryOptions = {}): DashboardRegistry {
    const from = clampInt(options.from, MANAGED_INSTANCE_PORT_FROM, 1, 65535);
    const maxCount = Math.max(1, 65535 - from + 1);
    const count = clampInt(options.count, MANAGED_INSTANCE_PORT_COUNT, 1, Math.min(MANAGED_INSTANCE_PORT_COUNT, maxCount));
    return { scan: { from, count }, ui: defaultUi(), instances: {} };
}

function normalizeUi(value: unknown): DashboardRegistryUi {
    const input = isRecord(value) ? value : {};
    const fallback = defaultUi();
    const selectedPort = input.selectedPort == null
        ? null
        : clampInt(input.selectedPort, 0, 1, 65535);
    const selectedTab = DETAIL_TABS.includes(input.selectedTab as DashboardDetailTab)
        ? input.selectedTab as DashboardDetailTab
        : fallback.selectedTab;
    const uiTheme = UI_THEMES.includes(input.uiTheme as DashboardUiTheme)
        ? input.uiTheme as DashboardUiTheme
        : fallback.uiTheme;
    return {
        selectedPort,
        selectedTab,
        sidebarCollapsed: typeof input.sidebarCollapsed === 'boolean' ? input.sidebarCollapsed : fallback.sidebarCollapsed,
        activityDockCollapsed: typeof input.activityDockCollapsed === 'boolean' ? input.activityDockCollapsed : fallback.activityDockCollapsed,
        activityDockHeight: clampInt(input.activityDockHeight, fallback.activityDockHeight, MIN_ACTIVITY_HEIGHT, MAX_ACTIVITY_HEIGHT),
        uiTheme,
    };
}

function normalizeInstance(value: unknown): DashboardRegistryInstance {
    const input = isRecord(value) ? value : {};
    return {
        label: readString(input.label),
        favorite: input.favorite === true,
        group: readString(input.group),
        hidden: input.hidden === true,
    };
}

export function normalizeDashboardRegistry(value: unknown, options: RegistryOptions = {}): DashboardRegistry {
    const input = isRecord(value) ? value : {};
    const defaults = defaultDashboardRegistry(options);
    const scan = isRecord(input.scan) ? input.scan : {};
    const from = validInt(scan.from, defaults.scan.from, 1, 65535);
    const count = clampInt(scan.count, defaults.scan.count, 1, Math.min(MANAGED_INSTANCE_PORT_COUNT, 65535 - from + 1));
    const instances: Record<string, DashboardRegistryInstance> = {};
    const rawInstances = isRecord(input.instances) ? input.instances : {};

    for (const [key, raw] of Object.entries(rawInstances)) {
        const port = Number(key);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || raw == null) continue;
        instances[String(port)] = normalizeInstance(raw);
    }

    return { scan: { from, count }, ui: normalizeUi(input.ui), instances };
}

function statusFor(path: string, loaded: boolean, error: string | null, registry: DashboardRegistry): DashboardRegistryStatus {
    return { path, loaded, error, ui: registry.ui };
}

export function loadDashboardRegistry(options: RegistryOptions = {}): DashboardRegistryLoadResult {
    const path = options.path || dashboardRegistryPath();
    if (!existsSync(path)) {
        const registry = defaultDashboardRegistry(options);
        return { registry, status: statusFor(path, true, null, registry) };
    }

    try {
        const registry = normalizeDashboardRegistry(JSON.parse(readFileSync(path, 'utf8')), options);
        return { registry, status: statusFor(path, true, null, registry) };
    } catch (error) {
        const registry = defaultDashboardRegistry(options);
        return { registry, status: statusFor(path, false, (error as Error).message, registry) };
    }
}

export function saveDashboardRegistry(registry: DashboardRegistry, options: RegistryOptions = {}): DashboardRegistryLoadResult {
    const path = options.path || dashboardRegistryPath();
    const normalized = normalizeDashboardRegistry(registry, options);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
    return { registry: normalized, status: statusFor(path, true, null, normalized) };
}

export function patchDashboardRegistry(patch: DashboardRegistryPatch, options: RegistryOptions = {}): DashboardRegistryLoadResult {
    const current = loadDashboardRegistry(options).registry;
    const next: DashboardRegistry = normalizeDashboardRegistry({
        scan: { ...current.scan, ...patch.scan },
        ui: { ...current.ui, ...patch.ui },
        instances: { ...current.instances },
    }, options);

    for (const [key, value] of Object.entries(patch.instances || {})) {
        const port = Number(key);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        if (value === null) {
            delete next.instances[String(port)];
            continue;
        }
        next.instances[String(port)] = normalizeInstance({ ...next.instances[String(port)], ...value });
    }

    return saveDashboardRegistry(next, options);
}

function overlayInstance(instance: DashboardInstance, registry: DashboardRegistry): DashboardInstance {
    const saved = registry.instances[String(instance.port)];
    return {
        ...instance,
        label: saved?.label || null,
        favorite: saved?.favorite === true,
        group: saved?.group || null,
        hidden: saved?.hidden === true,
    };
}

export function applyDashboardRegistry(result: DashboardScanResult, registry: DashboardRegistry, status: DashboardRegistryStatus, options: ApplyOptions = {}): DashboardScanResult {
    const instances = result.instances
        .map(instance => overlayInstance(instance, registry))
        .filter(instance => options.showHidden || !instance.hidden);

    return {
        manager: { ...result.manager, registry: status },
        instances,
    };
}
