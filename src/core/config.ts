// ─── Config: paths, settings, CLI detection ──────────

import os from 'os';
import fs from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { CLI_REGISTRY, CLI_KEYS, DEFAULT_CLI, buildDefaultPerCli } from '../cli/registry.js';

// ─── Version (single source of truth: package.json) ──
import { dirname } from 'path';
import { fileURLToPath } from 'url';

function findPackageJson(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== dirname(dir)) {
        const candidate = join(dir, 'package.json');
        if (fs.existsSync(candidate)) return candidate;
        dir = dirname(dir);
    }
    throw new Error('package.json not found');
}
const pkg = JSON.parse(fs.readFileSync(findPackageJson(), 'utf8'));
export const APP_VERSION: string = pkg.version;

// ─── Paths ───────────────────────────────────────────

export const JAW_HOME = process.env.CLI_JAW_HOME
    ? resolve(process.env.CLI_JAW_HOME.replace(/^~(?=\/|$)/, os.homedir()))
    : join(os.homedir(), '.cli-jaw');
export const PROMPTS_DIR = join(JAW_HOME, 'prompts');
export const DB_PATH = join(JAW_HOME, 'jaw.db');
export const SETTINGS_PATH = join(JAW_HOME, 'settings.json');
export const HEARTBEAT_JOBS_PATH = join(JAW_HOME, 'heartbeat.json');
export const UPLOADS_DIR = join(JAW_HOME, 'uploads');
export const MIGRATION_MARKER = join(JAW_HOME, '.migrated-v1');
export const SKILLS_DIR = join(JAW_HOME, 'skills');
export const SKILLS_REF_DIR = join(JAW_HOME, 'skills_ref');

// ─── Server URLs ────────────────────────────────────
export const DEFAULT_PORT = '3457';
export const CDP_PORT_OFFSET = 5783;  // 9240 - 3457

export function deriveCdpPort(serverPort?: number | string): number {
    const port = Number(serverPort || process.env.PORT || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 9240;
    const cdp = port + CDP_PORT_OFFSET;
    return cdp > 65535 ? 9240 : cdp;
}

export function getServerUrl(port: string | number | undefined) {
    return `http://localhost:${port || process.env.PORT || DEFAULT_PORT}`;
}
export function getWsUrl(port: string | number | undefined) {
    return `ws://localhost:${port || process.env.PORT || DEFAULT_PORT}`;
}

/** Locate the cli-jaw package root (for bundled skills_ref/) */
export function getProjectDir() {
    return dirname(findPackageJson());
}

// ─── Ensure directories ─────────────────────────────

export function ensureDirs() {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    fs.mkdirSync(SKILLS_REF_DIR, { recursive: true });
}

// ─── 1-time migration (Phase 9.2) ───────────────────

export function runMigration(projectDir: string) {
    if (fs.existsSync(MIGRATION_MARKER)) return;

    // Legacy claw.db → jaw.db rename (in-place)
    const legacyClaw = join(JAW_HOME, 'claw.db');
    if (fs.existsSync(legacyClaw) && !fs.existsSync(DB_PATH)) {
        fs.renameSync(legacyClaw, DB_PATH);
        for (const ext of ['-wal', '-shm']) {
            const src = legacyClaw + ext;
            const dst = DB_PATH + ext;
            if (fs.existsSync(src)) fs.renameSync(src, dst);
        }
        console.log('[migrate] claw.db → jaw.db');
    }

    const legacySettings = join(projectDir, 'settings.json');
    const legacyDb = join(projectDir, 'jaw.db');
    if (fs.existsSync(legacySettings) && !fs.existsSync(SETTINGS_PATH)) {
        fs.copyFileSync(legacySettings, SETTINGS_PATH);
        console.log('[migrate] settings.json → ~/.cli-jaw/');
    }
    if (fs.existsSync(legacyDb) && !fs.existsSync(DB_PATH)) {
        fs.copyFileSync(legacyDb, DB_PATH);
        for (const ext of ['-wal', '-shm']) {
            const src = legacyDb + ext;
            if (fs.existsSync(src)) fs.copyFileSync(src, DB_PATH + ext);
        }
        console.log('[migrate] jaw.db → ~/.cli-jaw/');
    }
    fs.writeFileSync(MIGRATION_MARKER, JSON.stringify({ migratedAt: new Date().toISOString() }));
}

// ─── Settings ────────────────────────────────────────

function createDefaultSettings() {
    return {
        cli: DEFAULT_CLI,
        fallbackOrder: [],
        permissions: 'auto',
        workingDir: JAW_HOME,
        perCli: buildDefaultPerCli(),
        heartbeat: {
            enabled: false,
            every: '30m',
            activeHours: { start: '08:00', end: '22:00' },
            target: 'all',
        },
        telegram: {
            enabled: false,
            token: '',
            allowedChatIds: [],
            forwardAll: true,
        },
        memory: {
            enabled: true,
            flushEvery: 10,
            cli: '',
            model: '',
            retentionDays: 30,
        },
        employees: [],
        locale: 'ko',
    };
}

export const DEFAULT_SETTINGS = createDefaultSettings();

function migrateSettings(s: Record<string, any>) {
    if (s.planning) {
        if (s.planning.cli && s.planning.cli !== s.cli) s.cli = s.planning.cli;
        if (s.planning.model && s.planning.model !== 'default') {
            const target = s.perCli?.[s.cli];
            if (target) target.model = s.planning.model;
        }
        if (s.planning.effort) {
            const target = s.perCli?.[s.cli];
            if (target) target.effort = s.planning.effort;
        }
        delete s.planning;
    }
    return s;
}

/** Mutable settings object — shared across all modules via ESM live binding */
export let settings: Record<string, any> = createDefaultSettings();

export function loadSettings() {
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        const defaults = createDefaultSettings();
        // Deep merge perCli so new CLI defaults (e.g. copilot) are preserved
        const mergedPerCli: Record<string, any> = buildDefaultPerCli();
        if (raw.perCli) {
            for (const [cli, cfg] of Object.entries(raw.perCli) as [string, Record<string, any>][]) {
                mergedPerCli[cli] = { ...(mergedPerCli[cli] || {}), ...cfg };
            }
        }
        const merged = migrateSettings({ ...defaults, ...raw, perCli: mergedPerCli });
        if (raw.planning) saveSettings(merged);
        settings = merged;
        return merged;
    } catch { /* expected: settings.json may not exist on first run */
        settings = createDefaultSettings();
        return settings;
    }
}

export function saveSettings(s: Record<string, any>) {
    settings = s;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

/** Replace settings object (for API PUT /api/settings deep merge) */
export function replaceSettings(s: Record<string, any>) {
    settings = s;
}

// ─── Heartbeat File I/O ──────────────────────────────
// Separated from heartbeat timers so prompt.js can import without circular dep

export function loadHeartbeatFile() {
    try {
        return JSON.parse(fs.readFileSync(HEARTBEAT_JOBS_PATH, 'utf8'));
    } catch { /* expected: heartbeat.json may not exist yet */
        return { jobs: [] };
    }
}

export function saveHeartbeatFile(data: Record<string, any>) {
    fs.writeFileSync(HEARTBEAT_JOBS_PATH, JSON.stringify(data, null, 2));
}

// ─── CLI Detection ───────────────────────────────────

export function detectCli(name: string) {
    if (!/^[a-z0-9_-]+$/i.test(name)) return { available: false, path: null };
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const raw = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3000 }).trim();
        const firstLine = raw.split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
        if (!firstLine) return { available: false, path: null };
        return { available: true, path: firstLine };
    } catch { /* expected: CLI binary may not be installed */ return { available: false, path: null }; }
}

export function detectAllCli() {
    const out: Record<string, any> = {};
    for (const key of CLI_KEYS) {
        const binary = (CLI_REGISTRY as Record<string, any>)[key]?.binary || key;
        out[key] = detectCli(binary);
    }
    return out;
}
