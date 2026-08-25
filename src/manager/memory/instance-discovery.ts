import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { loadDashboardRegistry } from '../registry.js';
import { defaultHomeForPort } from '../lifecycle-helpers.js';
import { resolveStructuredIndexDbPath } from '../../memory/shared.js';
import type { DashboardRegistry } from '../types.js';
import type { InstanceMemoryRef, ScanItemForFederation } from './types.js';

const BLACKLIST_PATTERNS: RegExp[] = [
    /^\.cli-jaw-manager-/,
    /^\.cli-jaw-dashboard$/,
    /^\.cli-jaw-smoke-/,
    /\.bak\./,
];

function isBlacklisted(homePath: string): boolean {
    return BLACKLIST_PATTERNS.some(rx => rx.test(basename(homePath)));
}

function resolveHomeForInstance(
    port: number,
    baseHome: string,
    override?: string | null,
): { path: string; source: 'profile' | 'default-port' } {
    if (override && typeof override === 'string' && override.trim()) {
        return { path: override, source: 'profile' };
    }
    return { path: defaultHomeForPort(port, baseHome), source: 'default-port' };
}

function buildRefs(
    registry: DashboardRegistry,
    baseHome: string,
    overrides: Map<number, string> | undefined,
    extraPorts?: Map<number, string | null>,
): InstanceMemoryRef[] {
    const out: InstanceMemoryRef[] = [];
    const seen = new Set<number>();
    const sources: Array<{ port: number; label: string | null; origin: 'registry' | 'scan' }> = [];
    for (const [portKey, info] of Object.entries(registry.instances)) {
        const port = Number(portKey);
        if (!Number.isFinite(port)) continue;
        sources.push({ port, label: info.label ?? null, origin: 'registry' });
        seen.add(port);
    }
    // Live ports the registry never learned about. Before #436 a home with no
    // registry.json produced instances: {} and the federation list came back empty
    // even with instances answering, because the scan was consulted for home
    // overrides only and never as a source of rows.
    for (const [port, label] of extraPorts ?? []) {
        if (!Number.isFinite(port) || seen.has(port)) continue;
        sources.push({ port, label: label ?? null, origin: 'scan' });
        seen.add(port);
    }
    for (const { port, label, origin } of sources) {
        const override = overrides?.get(port) ?? null;
        const home = resolveHomeForInstance(port, baseHome, override);
        if (isBlacklisted(home.path)) continue;
        const dbPath = resolveStructuredIndexDbPath(home.path);
        let hasDb = false;
        try {
            hasDb = existsSync(dbPath) && statSync(dbPath).isFile();
        } catch {
            hasDb = false;
        }
        const chatDbPath = join(home.path, 'jaw.db');
        let hasChatDb = false;
        try {
            hasChatDb = existsSync(chatDbPath) && statSync(chatDbPath).isFile();
        } catch {
            hasChatDb = false;
        }
        out.push({
            instanceId: String(port),
            homePath: home.path,
            homeSource: home.source,
            port,
            label,
            dbPath,
            hasDb,
            chatDbPath,
            hasChatDb,
            origin,
        });
    }
    return out;
}

export function listSearchableInstances(opts: { baseHome?: string } = {}): InstanceMemoryRef[] {
    const { registry } = loadDashboardRegistry();
    const baseHome = opts.baseHome ?? homedir();
    return buildRefs(registry, baseHome, undefined);
}

export function listSearchableInstancesAt(
    registry: DashboardRegistry,
    baseHome: string,
    overrides?: Map<number, string>,
): InstanceMemoryRef[] {
    return buildRefs(registry, baseHome, overrides);
}

export function listSearchableInstancesFromScan(
    scanItems: ScanItemForFederation[],
    opts: { baseHome?: string; registry?: DashboardRegistry } = {},
): InstanceMemoryRef[] {
    const registry = opts.registry ?? loadDashboardRegistry().registry;
    const baseHome = opts.baseHome ?? homedir();
    const overrides = new Map<number, string>();
    // Only ONLINE scan rows become list entries. A full scan walks 50 ports from
    // 3457 and keeps offline/timeout rows, so unioning it wholesale would bury the
    // two real instances under 48 dead ones (#436).
    const liveFromScan = new Map<number, string | null>();
    for (const item of scanItems) {
        const port = item.port;
        if (!Number.isFinite(port)) continue;
        if (item.ok) liveFromScan.set(port, item.homeDisplay ?? null);
        let resolved: string | null = null;
        if (item.profileId) {
            const profile = registry.profiles?.[item.profileId as keyof typeof registry.profiles];
            if (profile && typeof profile.homePath === 'string' && profile.homePath.trim()) {
                resolved = profile.homePath;
            }
        }
        if (!resolved && item.homeDisplay && item.homeDisplay.trim()) {
            resolved = item.homeDisplay;
        }
        if (resolved) overrides.set(port, resolved);
    }
    return buildRefs(registry, baseHome, overrides, liveFromScan);
}

export type { ScanItemForFederation };
