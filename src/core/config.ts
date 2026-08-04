// ─── Config: paths, settings, CLI detection ──────────

import os from 'os';
import fs from 'fs';
import path from 'path';
import { join } from 'path';
import { DEFAULT_CLI, buildDefaultPerCli } from '../cli/registry.js';
import { pickFirstReadyCli } from '../cli/readiness.js';
import { migrateLegacyClaudeValue } from '../cli/claude-models.js';
import { resolveHomePath } from './path-expand.js';
export { detectAllCli, detectCli, getClaudeExecHelperCandidates, getClaudeIHelperCandidates } from './cli-detection.js';

// ─── Version (single source of truth: package.json) ──
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

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

export const JAW_HOME = process.env["CLI_JAW_HOME"]
    ? resolveHomePath(process.env["CLI_JAW_HOME"])
    : join(os.homedir(), '.cli-jaw');
export const PROMPTS_DIR = join(JAW_HOME, 'prompts');
export const DB_PATH = join(JAW_HOME, 'jaw.db');
export const SETTINGS_PATH = join(JAW_HOME, 'settings.json');
// Remote-auth token file (server.ts writes JAW_AUTH_TOKEN here at boot,
// 0600). Loopback never needs it; LAN/remote API clients and operators do.
export const TOKEN_PATH = join(JAW_HOME, 'token');
export const HEARTBEAT_JOBS_PATH = join(JAW_HOME, 'heartbeat.json');
export const UPLOADS_DIR = join(JAW_HOME, 'uploads');
export const WIDGETS_DIR = join(JAW_HOME, 'widgets');
export const MIGRATION_MARKER = join(JAW_HOME, '.migrated-v1');
export const SKILLS_DIR = join(JAW_HOME, 'skills');
export const SKILLS_REF_DIR = join(JAW_HOME, 'skills_ref');

// ─── Server URLs ────────────────────────────────────
export const DEFAULT_PORT = '3457';
export const CDP_PORT_OFFSET = 5783;  // 9240 - 3457

// Option D rollout (devlog 260620 Phase 3): when set, /api/messages rebuilds a
// finished message's tool cards from trace_events (durable, uncapped) instead of the
// messages.tool_log blob. Default OFF — flip per-surface after parity is verified.
export const HYDRATE_TOOL_CARDS_FROM_TRACE =
    ['1', 'true', 'yes'].includes(String(process.env["JAW_HYDRATE_TOOL_CARDS_FROM_TRACE"] || '').toLowerCase());

export function deriveCdpPort(serverPort?: number | string): number {
    const port = Number(serverPort || process.env["PORT"] || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 9240;
    const cdp = port + CDP_PORT_OFFSET;
    return cdp > 65535 ? 9240 : cdp;
}

export function getServerUrl(port?: string | number) {
    // 127.0.0.1, not localhost: skips the dual-stack (::1-first) lookup and
    // the happy-eyeballs fallback on every new connection (260613 doc 60).
    return `http://127.0.0.1:${port || process.env["PORT"] || settings["port"] || DEFAULT_PORT}`;
}
export function getWsUrl(port?: string | number) {
    return `ws://127.0.0.1:${port || process.env["PORT"] || settings["port"] || DEFAULT_PORT}`;
}

/** Locate the cli-jaw package root (for bundled skills_ref/) */
export function getProjectDir() {
    return dirname(findPackageJson());
}

// ─── Project workspace dirs ─────────────────────────

export function getProjectDirs(): string[] | null {
    const dirs = settings["projectDirs"];
    if (!Array.isArray(dirs) || dirs.length === 0) return null;
    return dirs;
}

export function setProjectDirs(dirs: string[] | null): void {
    const normalized = normalizeProjectDirs(dirs);
    settings["projectDirs"] = normalized;
    saveSettings(settings);
}

export function clearProjectDirs(): void {
    setProjectDirs(null);
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const MAX_PROJECT_DIRS = 20;
const MAX_PATH_LENGTH = 4096;

export function normalizeProjectDirs(dirs: unknown): string[] | null {
    if (!Array.isArray(dirs) || dirs.length === 0) return null;
    const cleaned = dirs
        .slice(0, MAX_PROJECT_DIRS)
        .filter((d): d is string => typeof d === 'string')
        .map(d => d.trim())
        .filter(d => d.length > 0 && d.length <= MAX_PATH_LENGTH)
        .filter(d => {
            if (CONTROL_CHAR_RE.test(d)) {
                console.warn(`⚠ Skipping path with control characters: ${JSON.stringify(d)}`);
                return false;
            }
            if (!path.isAbsolute(d)) {
                console.warn(`⚠ Skipping non-absolute path: ${d}`);
                return false;
            }
            return true;
        })
        .map(d => {
            try {
                const real = fs.realpathSync.native(d);
                const stat = fs.statSync(real);
                if (!stat.isDirectory()) {
                    console.warn(`⚠ Skipping non-directory path: ${d}`);
                    return null;
                }
                return real;
            } catch {
                console.warn(`⚠ Skipping non-existent path: ${d}`);
                return null;
            }
        })
        .filter((d): d is string => d !== null);
    const deduped = [...new Set(cleaned)];
    return deduped.length > 0 ? deduped : null;
}

// ─── Ensure directories ─────────────────────────────

export function ensureDirs() {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(WIDGETS_DIR, { recursive: true });
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
        log.info('[migrate] claw.db → jaw.db');
    }

    const legacySettings = join(projectDir, 'settings.json');
    const legacyDb = join(projectDir, 'jaw.db');
    if (fs.existsSync(legacySettings) && !fs.existsSync(SETTINGS_PATH)) {
        fs.copyFileSync(legacySettings, SETTINGS_PATH);
        log.info('[migrate] settings.json → ~/.cli-jaw/');
    }
    if (fs.existsSync(legacyDb) && !fs.existsSync(DB_PATH)) {
        fs.copyFileSync(legacyDb, DB_PATH);
        for (const ext of ['-wal', '-shm']) {
            const src = legacyDb + ext;
            if (fs.existsSync(src)) fs.copyFileSync(src, DB_PATH + ext);
        }
        log.info('[migrate] jaw.db → ~/.cli-jaw/');
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
        pi: {
            defaultProfileId: 'progrok',
            profiles: [{
                id: 'progrok',
                label: 'Progrok',
                mode: 'basic',
                endpoint: 'http://127.0.0.1:18645/v1',
                apiKind: 'openai-completions',
                apiKey: 'dummy',
                model: 'grok-composer-2.5-fast',
                reasoning: true,
                supportsDeveloperRole: true,
                supportsReasoningEffort: true,
            }],
            discoveredModels: {
                progrok: ['grok-composer-2.5-fast', 'grok-4.5', 'grok-4.3'],
            },
        },
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
            allowBots: false,
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
        slack: {
            enabled: false,
            botToken: '',
            appToken: '',
            teamId: '',
            channelIds: [] as string[],
            forwardAll: true,
            allowBots: false,
            // Slack bots typically live in shared team channels, where
            // answering every message is antisocial. DMs bypass this gate.
            mentionOnly: true,
            replyInThread: true,
        },
        messaging: {
            latestSeen: { telegram: null, discord: null, slack: null },
            lastActive: { telegram: null, discord: null, slack: null },
        },
        multiSession: { enabled: false },
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
        trace: {
            retentionDays: 7,
            maxRows: 50000,
        },
        code: {
            maxConcurrentSessions: 4,
            idleReapMs: 30_000,
        },
        tui: {
            pasteCollapseLines: 2,
            pasteCollapseChars: 160,
            keymapPreset: 'default',
            diffStyle: 'summary',
            themeSeed: 'jaw-default',
        },
        employees: [],
        projectDirs: null as string[] | null,
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
        jawCeo: {
            openaiApiKey: '',
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
    if (cli === 'claude' || cli === 'claude-e') return migrateLegacyClaudeValue(model);
    if (cli === 'copilot' && model === 'claude-opus-4.6-fast') return 'claude-opus-4.6';
    return model;
}

function normalizePerCliModels(perCli: Record<string, any> = {}) {
    const next: Record<string, any> = {};
    for (const [cli, cfg] of Object.entries(perCli)) {
        const provider = cli === 'ai-e' && typeof cfg?.provider === 'string' ? cfg.provider : undefined;
        next[cli] = {
            ...cfg,
            model: provider === 'claude'
                ? migrateLegacyClaudeValue(cfg?.model || '')
                : normalizeModelForCli(cli, cfg?.model),
        };
    }
    return next;
}

function normalizeActiveOverrides(activeOverrides: Record<string, any> = {}, perCli: Record<string, any> = {}) {
    const next: Record<string, any> = {};
    for (const [cli, cfg] of Object.entries(activeOverrides)) {
        const provider = cli === 'ai-e'
            ? (typeof cfg?.provider === 'string' ? cfg.provider : typeof perCli['ai-e']?.provider === 'string' ? perCli['ai-e'].provider : undefined)
            : undefined;
        next[cli] = {
            ...cfg,
            model: provider === 'claude'
                ? migrateLegacyClaudeValue(cfg?.model || '')
                : normalizeModelForCli(cli, cfg?.model),
        };
    }
    return next;
}

/** @internal — exported for unit testing */
export function migrateSettings(s: Record<string, any>) {
    if (s["planning"]) {
        if (s["planning"].cli && s["planning"].cli !== s["cli"]) s["cli"] = s["planning"].cli;
        if (s["planning"].model && s["planning"].model !== 'default') {
            const target = s["perCli"]?.[s["cli"]];
            if (target) target.model = s["planning"].model;
        }
        if (s["planning"].effort) {
            const target = s["perCli"]?.[s["cli"]];
            if (target) target.effort = s["planning"].effort;
        }
        delete s["planning"];
    }

    // Claude model alias migration
    s["perCli"] = normalizePerCliModels(s["perCli"] || {});
    s["activeOverrides"] = normalizeActiveOverrides(s["activeOverrides"] || {}, s["perCli"] || {});
    if (typeof s["memory"]?.cli === 'string' && typeof s["memory"]?.model === 'string') {
        s["memory"].model = normalizeModelForCli(s["memory"].cli, s["memory"].model);
    }

    // Discord/channel migration
    if (!s["channel"]) s["channel"] = 'telegram';
    if (!s["discord"]) {
        s["discord"] = {
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
    if (s["telegram"] && s["telegram"].mentionOnly === undefined) {
        s["telegram"].mentionOnly = true;
    }
    // Telegram allowBots migration — added with the self-echo guard (260802).
    // Defaults to false to match Discord: another bot in the group is not a
    // user, and answering one is how loops start.
    if (s["telegram"] && s["telegram"].allowBots === undefined) {
        s["telegram"].allowBots = false;
    }
    // Slack channel migration — added 260802, absent from all prior settings files
    if (!s["slack"]) {
        s["slack"] = {
            enabled: false,
            botToken: '',
            appToken: '',
            teamId: '',
            channelIds: [],
            forwardAll: true,
            allowBots: false,
            mentionOnly: true,
            replyInThread: true,
        };
    }
    if (!s["messaging"]) {
        s["messaging"] = {
            latestSeen: { telegram: null, discord: null, slack: null },
            lastActive: { telegram: null, discord: null, slack: null },
        };
    } else {
        // Existing installs already have a messaging block; a bare
        // `if (!s["messaging"])` would never add the slack slot for them.
        if (s["messaging"].latestSeen && s["messaging"].latestSeen.slack === undefined) {
            s["messaging"].latestSeen.slack = null;
        }
        if (s["messaging"].lastActive && s["messaging"].lastActive.slack === undefined) {
            s["messaging"].lastActive.slack = null;
        }
    }
    if (!s["multiSession"]) s["multiSession"] = { enabled: false };
    if (!s["jawCeo"]) {
        s["jawCeo"] = { openaiApiKey: '' };
    }
    if (!s["pi"]) {
        s["pi"] = createDefaultSettings().pi;
    }
    return s;
}

/** Apply environment variable overrides to a settings object */
function applyEnvOverrides(s: Record<string, any>) {
    if (process.env["TELEGRAM_TOKEN"]) {
        s["telegram"] = s["telegram"] || {};
        s["telegram"].token = process.env["TELEGRAM_TOKEN"];
        s["telegram"].enabled = true;
    }
    if (process.env["TELEGRAM_ALLOWED_CHAT_IDS"]) {
        s["telegram"] = s["telegram"] || {};
        s["telegram"].allowedChatIds = process.env["TELEGRAM_ALLOWED_CHAT_IDS"].split(',').map((x: string) => x.trim()).filter(Boolean);
    }
    if (process.env["DISCORD_TOKEN"]) {
        s["discord"] = s["discord"] || {};
        s["discord"].token = process.env["DISCORD_TOKEN"];
        s["discord"].enabled = true;
        // Auto-switch active channel if Discord has token but Telegram doesn't
        if (!s["telegram"]?.token && !s["telegram"]?.enabled) {
            s["channel"] = 'discord';
        }
    }
    if (process.env["DISCORD_GUILD_ID"]) {
        s["discord"] = s["discord"] || {};
        s["discord"].guildId = process.env["DISCORD_GUILD_ID"];
    }
    if (process.env["DISCORD_CHANNEL_IDS"]) {
        s["discord"] = s["discord"] || {};
        s["discord"].channelIds = process.env["DISCORD_CHANNEL_IDS"].split(',').map((x: string) => x.trim()).filter(Boolean);
    }
    // Slack: unlike Discord, presence of a token does NOT auto-switch the
    // active channel. Slack needs BOTH tokens to function, so hijacking the
    // active inbound channel from a half-configured env is a footgun.
    if (process.env["SLACK_BOT_TOKEN"]) {
        s["slack"] = s["slack"] || {};
        s["slack"].botToken = process.env["SLACK_BOT_TOKEN"];
        s["slack"].enabled = true;
    }
    if (process.env["SLACK_APP_TOKEN"]) {
        s["slack"] = s["slack"] || {};
        s["slack"].appToken = process.env["SLACK_APP_TOKEN"];
    }
    if (process.env["SLACK_TEAM_ID"]) {
        s["slack"] = s["slack"] || {};
        s["slack"].teamId = process.env["SLACK_TEAM_ID"];
    }
    if (process.env["SLACK_CHANNEL_IDS"]) {
        s["slack"] = s["slack"] || {};
        s["slack"].channelIds = process.env["SLACK_CHANNEL_IDS"].split(',').map((x: string) => x.trim()).filter(Boolean);
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
            slack: { ...defaults.slack, ...(raw.slack || {}) },
            memory: { ...defaults.memory, ...(raw.memory || {}) },
            trace: { ...defaults.trace, ...(raw.trace || {}) },
            avatar: {
                agent: { ...defaults.avatar.agent, ...(raw.avatar?.agent || {}) },
                user: { ...defaults.avatar.user, ...(raw.avatar?.user || {}) },
            },
            messaging: {
                latestSeen: { ...defaults.messaging.latestSeen, ...(raw.messaging?.latestSeen || {}) },
                lastActive: { ...defaults.messaging.lastActive, ...(raw.messaging?.lastActive || {}) },
            },
            jawCeo: { ...defaults.jawCeo, ...(raw.jawCeo || {}) },
            pi: { ...defaults.pi, ...(raw.pi || {}) },
            network: { ...defaults.network, ...(raw.network || {}) },
            code: { ...defaults.code, ...(raw.code || {}) },
        });
        // #64 safety: auto-correct stale workingDir (e.g. copied instance)
        // but allow valid paths to persist (dynamic project targeting)
        if (typeof merged["workingDir"] === 'string' && merged["workingDir"] !== JAW_HOME && !fs.existsSync(merged["workingDir"])) {
            console.warn(`[jaw:workingDir] stale path ${merged["workingDir"]}, resetting to JAW_HOME`);
            merged["workingDir"] = JAW_HOME;
            saveSettings(merged);
        }
        if (raw.planning) saveSettings(merged);

        // normalize projectDirs on load (reject corrupted/injected values)
        merged["projectDirs"] = normalizeProjectDirs(merged["projectDirs"]);

        // env overrides
        applyEnvOverrides(merged);

        // Heal loose permissions on existing installs: settings.json holds
        // live channel tokens and must be owner-only. Once per load, not per
        // save, so a hand-chmod'd 0644 is caught even before the next write.
        if (process.platform !== 'win32') {
            try {
                const mode = fs.statSync(SETTINGS_PATH).mode;
                if (mode & 0o077) {
                    fs.chmodSync(SETTINGS_PATH, 0o600);
                    console.warn('[jaw:settings] tightened settings.json permissions to 0600 (tokens inside)');
                }
            } catch { /* best-effort */ }
        }

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

// Self-write fingerprint for the settings watcher: external writers (a separate
// `cli-jaw project set` process) produce content that won't match this string.
let lastSavedSettingsRaw: string | null = null;

export function saveSettings(s: Record<string, any>) {
    settings = s;
    const raw = JSON.stringify(s, null, 2);
    lastSavedSettingsRaw = raw;
    // settings.json carries live channel tokens (xoxb-/xapp-/bot tokens), so
    // it must never be group/other-readable. writeFileSync's mode applies
    // only at creation — chmod covers the existing-file path.
    fs.writeFileSync(SETTINGS_PATH, raw, { mode: 0o600 });
    if (process.platform !== 'win32') {
        try { fs.chmodSync(SETTINGS_PATH, 0o600); } catch { /* best-effort */ }
    }
}

export function getLastSavedSettingsRaw(): string | null {
    return lastSavedSettingsRaw;
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
    runner?: 'main' | 'employee' | 'script';
    employee?: string;
    command?: string[];
    reportPolicy?: 'always' | 'anomaly_only' | 'silent';
}
export interface HeartbeatFile { jobs: HeartbeatJob[] }

export function loadHeartbeatFile(): HeartbeatFile {
    try {
        const parsed = JSON.parse(fs.readFileSync(HEARTBEAT_JOBS_PATH, 'utf8')) as HeartbeatFile;
        if (!Array.isArray(parsed.jobs)) return parsed;
        return { ...parsed, jobs: parsed.jobs.map(normalizeHeartbeatJob) };
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') {
            throw Object.assign(new Error(`heartbeat_load_failed: ${err?.message || String(error)}`), {
                statusCode: 500,
                code: 'heartbeat_load_failed',
                cause: error,
            });
        }
        return { jobs: [] };
    }
}

function normalizeHeartbeatJob(job: HeartbeatJob): HeartbeatJob {
    const runner = job.runner ?? 'main';
    const validRunner = runner === 'main' || runner === 'employee' || runner === 'script';
    const validEmployee = runner !== 'employee' || (typeof job.employee === 'string' && job.employee.trim().length > 0);
    const validCommand = runner !== 'script' || (Array.isArray(job.command) && job.command.length > 0 && job.command.every(part => typeof part === 'string' && part.length > 0));
    if (!validRunner || !validEmployee || !validCommand) {
        console.warn(`[heartbeat:${job.name || job.id || 'unknown'}] invalid runner configuration; falling back to main`);
        return { ...job, runner: 'main' };
    }
    const reportPolicy = job.reportPolicy ?? 'always';
    if (reportPolicy !== 'always' && reportPolicy !== 'anomaly_only' && reportPolicy !== 'silent') {
        console.warn(`[heartbeat:${job.name || job.id || 'unknown'}] invalid report policy; falling back to always`);
        return { ...job, runner, reportPolicy: 'always' };
    }
    return { ...job, runner, reportPolicy };
}

export function saveHeartbeatFile(data: HeartbeatFile | Record<string, unknown>) {
    fs.writeFileSync(HEARTBEAT_JOBS_PATH, JSON.stringify(data, null, 2));
}
