// ─── Config: paths, settings, CLI detection ──────────

import os from 'os';
import fs from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { CLI_REGISTRY, CLI_KEYS, DEFAULT_CLI, buildDefaultPerCli } from '../cli-registry.js';

// ─── Version (single source of truth: package.json) ──
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
export const APP_VERSION = pkg.version;

// ─── Paths ───────────────────────────────────────────

export const CLAW_HOME = join(os.homedir(), '.cli-claw');
export const PROMPTS_DIR = join(CLAW_HOME, 'prompts');
export const DB_PATH = join(CLAW_HOME, 'claw.db');
export const SETTINGS_PATH = join(CLAW_HOME, 'settings.json');
export const HEARTBEAT_JOBS_PATH = join(CLAW_HOME, 'heartbeat.json');
export const UPLOADS_DIR = join(CLAW_HOME, 'uploads');
export const MIGRATION_MARKER = join(CLAW_HOME, '.migrated-v1');
export const SKILLS_DIR = join(CLAW_HOME, 'skills');
export const SKILLS_REF_DIR = join(CLAW_HOME, 'skills_ref');

// ─── Server URLs ────────────────────────────────────
export const DEFAULT_PORT = '3457';
export function getServerUrl(port) {
    return `http://localhost:${port || process.env.PORT || DEFAULT_PORT}`;
}
export function getWsUrl(port) {
    return `ws://localhost:${port || process.env.PORT || DEFAULT_PORT}`;
}

/** Locate the cli-claw package root (for bundled skills_ref/) */
export function getProjectDir() {
    return join(new URL('.', import.meta.url).pathname, '..');
}

// ─── Ensure directories ─────────────────────────────

export function ensureDirs() {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    fs.mkdirSync(SKILLS_REF_DIR, { recursive: true });
}

// ─── 1-time migration (Phase 9.2) ───────────────────

export function runMigration(projectDir) {
    if (fs.existsSync(MIGRATION_MARKER)) return;
    const legacySettings = join(projectDir, 'settings.json');
    const legacyDb = join(projectDir, 'claw.db');
    if (fs.existsSync(legacySettings) && !fs.existsSync(SETTINGS_PATH)) {
        fs.copyFileSync(legacySettings, SETTINGS_PATH);
        console.log('[migrate] settings.json → ~/.cli-claw/');
    }
    if (fs.existsSync(legacyDb) && !fs.existsSync(DB_PATH)) {
        fs.copyFileSync(legacyDb, DB_PATH);
        for (const ext of ['-wal', '-shm']) {
            const src = legacyDb + ext;
            if (fs.existsSync(src)) fs.copyFileSync(src, DB_PATH + ext);
        }
        console.log('[migrate] claw.db → ~/.cli-claw/');
    }
    fs.writeFileSync(MIGRATION_MARKER, JSON.stringify({ migratedAt: new Date().toISOString() }));
}

// ─── Settings ────────────────────────────────────────

function createDefaultSettings() {
    return {
        cli: DEFAULT_CLI,
        fallbackOrder: [],
        permissions: 'safe',
        workingDir: os.homedir(),
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

function migrateSettings(s) {
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
export let settings = createDefaultSettings();

export function loadSettings() {
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        const defaults = createDefaultSettings();
        // Deep merge perCli so new CLI defaults (e.g. copilot) are preserved
        const mergedPerCli = buildDefaultPerCli();
        if (raw.perCli) {
            for (const [cli, cfg] of Object.entries(raw.perCli)) {
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

export function saveSettings(s) {
    settings = s;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

/** Replace settings object (for API PUT /api/settings deep merge) */
export function replaceSettings(s) {
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

export function saveHeartbeatFile(data) {
    fs.writeFileSync(HEARTBEAT_JOBS_PATH, JSON.stringify(data, null, 2));
}

// ─── CLI Detection ───────────────────────────────────

export function detectCli(name) {
    if (!/^[a-z0-9_-]+$/i.test(name)) return { available: false, path: null };
    try {
        const p = execFileSync('which', [name], { encoding: 'utf8', timeout: 3000 }).trim();
        return { available: true, path: p };
    } catch { /* expected: CLI binary may not be installed */ return { available: false, path: null }; }
}

export function detectAllCli() {
    const out = {};
    for (const key of CLI_KEYS) {
        const binary = CLI_REGISTRY[key]?.binary || key;
        out[key] = detectCli(binary);
    }
    return out;
}
