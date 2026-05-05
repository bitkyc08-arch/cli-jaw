// ─── Config: paths, settings, CLI detection ──────────

import os from 'os';
import fs from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { CLI_REGISTRY, CLI_KEYS, DEFAULT_CLI, buildDefaultPerCli } from '../cli/registry.js';
import { pickFirstReadyCli } from '../cli/readiness.js';
import { migrateLegacyClaudeValue } from '../cli/claude-models.js';
import { buildServicePath } from './runtime-path.js';
import { resolveHomePath } from './path-expand.js';

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
    ? resolveHomePath(process.env.CLI_JAW_HOME)
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

export function getServerUrl(port?: string | number) {
    return `http://localhost:${port || process.env.PORT || settings.port || DEFAULT_PORT}`;
}
export function getWsUrl(port?: string | number) {
    return `ws://localhost:${port || process.env.PORT || settings.port || DEFAULT_PORT}`;
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
        port: '',  // persisted by server on startup; CLI commands use as fallback
        cli: DEFAULT_CLI,
        fallbackOrder: [],
        showReasoning: false,
        permissions: 'auto',
        workingDir: JAW_HOME,
        perCli: buildDefaultPerCli(),
        heartbeat: {
            enabled: false,
            every: '30m',
            activeHours: { start: '08:00', end: '22:00' },
            target: 'all',
        },
        channel: 'telegram' as const,
        telegram: {
            enabled: false,
            token: '',
            allowedChatIds: [],
            forwardAll: true,
            mentionOnly: true,
        },
        discord: {
            enabled: false,
            token: '',
            guildId: '',
            channelIds: [] as string[],
            forwardAll: true,
            allowBots: false,
            mentionOnly: false,
        },
        messaging: {
            latestSeen: { telegram: null, discord: null },
            lastActive: { telegram: null, discord: null },
        },
        memory: {
            enabled: true,
            flushEvery: 10,
            cli: '',
            model: '',
            retentionDays: 30,
            flushLanguage: 'en',
            autoReflectAfterFlush: false,
            flushMessageWindow: 0,
        },
        tui: {
            pasteCollapseLines: 2,
            pasteCollapseChars: 160,
            keymapPreset: 'default',
            diffStyle: 'summary',
            themeSeed: 'jaw-default',
        },
        employees: [],
        locale: 'ko',
        avatar: {
            agent: {
                imagePath: '',
                updatedAt: null,
            },
            user: {
                imagePath: '',
                updatedAt: null,
            },
        },
        stt: {
            engine: 'auto',
            geminiApiKey: '',
            geminiModel: 'gemini-2.5-flash-lite',
            promptPath: 'prompts/stt-system.md',
            whisperModel: 'mlx-community/whisper-large-v3-turbo',
            openaiBaseUrl: '',
            openaiApiKey: '',
            openaiModel: '',
            vertexConfig: '',
        },
        network: {
            bindHost: '127.0.0.1',
            lanBypass: false,
            remoteAccess: {
                mode: 'off' as const,
                trustProxies: false,
                trustForwardedFor: false,
                publicOriginHint: '',
                requireAuth: true,
            },
        },
    };
}

export const DEFAULT_SETTINGS = createDefaultSettings();

export function normalizeModelForCli(cli: string, model: unknown): unknown {
    if (typeof model !== 'string') return model;
    if (cli === 'claude') return migrateLegacyClaudeValue(model);
    if (cli === 'copilot' && model === 'claude-opus-4.6-fast') return 'claude-opus-4.6';
    return model;
}

function normalizePerCliModels(perCli: Record<string, any> = {}) {
    const next: Record<string, any> = {};
    for (const [cli, cfg] of Object.entries(perCli)) {
        next[cli] = {
            ...cfg,
            model: normalizeModelForCli(cli, cfg?.model),
        };
    }
    return next;
}

function normalizeActiveOverrides(activeOverrides: Record<string, any> = {}) {
    const next: Record<string, any> = {};
    for (const [cli, cfg] of Object.entries(activeOverrides)) {
        next[cli] = {
            ...cfg,
            model: normalizeModelForCli(cli, cfg?.model),
        };
    }
    return next;
}

/** @internal — exported for unit testing */
export function migrateSettings(s: Record<string, any>) {
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

    // Claude model alias migration
    s.perCli = normalizePerCliModels(s.perCli || {});
    s.activeOverrides = normalizeActiveOverrides(s.activeOverrides || {});
    if (typeof s.memory?.cli === 'string' && typeof s.memory?.model === 'string') {
        s.memory.model = normalizeModelForCli(s.memory.cli, s.memory.model);
    }

    // Discord/channel migration
    if (!s.channel) s.channel = 'telegram';
    if (!s.discord) {
        s.discord = {
            enabled: false,
            token: '',
            guildId: '',
            channelIds: [],
            forwardAll: true,
            allowBots: false,
            mentionOnly: false,
        };
    }
    // Telegram mentionOnly migration — existing users had hardcoded always-on behavior
    if (s.telegram && s.telegram.mentionOnly === undefined) {
        s.telegram.mentionOnly = true;
    }
    if (!s.messaging) {
        s.messaging = {
            latestSeen: { telegram: null, discord: null },
            lastActive: { telegram: null, discord: null },
        };
    }
    return s;
}

/** Apply environment variable overrides to a settings object */
function applyEnvOverrides(s: Record<string, any>) {
    if (process.env.TELEGRAM_TOKEN) {
        s.telegram = s.telegram || {};
        s.telegram.token = process.env.TELEGRAM_TOKEN;
        s.telegram.enabled = true;
    }
    if (process.env.TELEGRAM_ALLOWED_CHAT_IDS) {
        s.telegram = s.telegram || {};
        s.telegram.allowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS.split(',').map((x: string) => x.trim()).filter(Boolean);
    }
    if (process.env.DISCORD_TOKEN) {
        s.discord = s.discord || {};
        s.discord.token = process.env.DISCORD_TOKEN;
        s.discord.enabled = true;
        // Auto-switch active channel if Discord has token but Telegram doesn't
        if (!s.telegram?.token && !s.telegram?.enabled) {
            s.channel = 'discord';
        }
    }
    if (process.env.DISCORD_GUILD_ID) {
        s.discord = s.discord || {};
        s.discord.guildId = process.env.DISCORD_GUILD_ID;
    }
    if (process.env.DISCORD_CHANNEL_IDS) {
        s.discord = s.discord || {};
        s.discord.channelIds = process.env.DISCORD_CHANNEL_IDS.split(',').map((x: string) => x.trim()).filter(Boolean);
    }
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
        const merged = migrateSettings({
            ...defaults,
            ...raw,
            perCli: mergedPerCli,
            tui: { ...defaults.tui, ...(raw.tui || {}) },
            telegram: { ...defaults.telegram, ...(raw.telegram || {}) },
            discord: { ...defaults.discord, ...(raw.discord || {}) },
            memory: { ...defaults.memory, ...(raw.memory || {}) },
            avatar: {
                agent: { ...defaults.avatar.agent, ...(raw.avatar?.agent || {}) },
                user: { ...defaults.avatar.user, ...(raw.avatar?.user || {}) },
            },
            messaging: {
                latestSeen: { ...defaults.messaging.latestSeen, ...(raw.messaging?.latestSeen || {}) },
                lastActive: { ...defaults.messaging.lastActive, ...(raw.messaging?.lastActive || {}) },
            },
            network: { ...defaults.network, ...(raw.network || {}) },
        });
        // --home (JAW_HOME) always wins over persisted workingDir (#64 hotfix)
        if (merged.workingDir !== JAW_HOME) {
            merged.workingDir = JAW_HOME;
            saveSettings(merged);
        }
        if (raw.planning) saveSettings(merged);

        // env overrides
        applyEnvOverrides(merged);

        settings = merged;
        return merged;
    } catch (error) {
        const next = createDefaultSettings();
        next.cli = pickFirstReadyCli();
        applyEnvOverrides(next);
        settings = next;

        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
            saveSettings(next);
            return next;
        }

        console.warn(`[jaw:settings] failed to load ${SETTINGS_PATH}: ${err?.message || String(error)}`);
        if (fs.existsSync(SETTINGS_PATH)) {
            const backupPath = `${SETTINGS_PATH}.corrupt-${Date.now()}.bak`;
            try {
                fs.copyFileSync(SETTINGS_PATH, backupPath);
                console.warn(`[jaw:settings] backed up unreadable settings to ${backupPath}`);
            } catch (backupErr) {
                console.warn(`[jaw:settings] backup failed: ${(backupErr as Error).message}`);
            }
        }
        return next;
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

export interface HeartbeatJob {
    id?: string;
    name?: string;
    enabled?: boolean;
    prompt?: string;
    schedule?: unknown;
}
export interface HeartbeatFile { jobs: HeartbeatJob[] }

export function loadHeartbeatFile(): HeartbeatFile {
    try {
        return JSON.parse(fs.readFileSync(HEARTBEAT_JOBS_PATH, 'utf8')) as HeartbeatFile;
    } catch { /* expected: heartbeat.json may not exist yet */
        return { jobs: [] };
    }
}

export function saveHeartbeatFile(data: HeartbeatFile | Record<string, unknown>) {
    fs.writeFileSync(HEARTBEAT_JOBS_PATH, JSON.stringify(data, null, 2));
}

// ─── CLI Detection ───────────────────────────────────

export function detectCli(name: string) {
    if (!/^[a-z0-9_-]+$/i.test(name)) return { available: false, path: null };
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const raw = execFileSync(cmd, [name], {
            encoding: 'utf8',
            timeout: 3000,
            env: {
                ...process.env,
                PATH: buildServicePath(process.env.PATH || ''),
            },
        }).trim();
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
