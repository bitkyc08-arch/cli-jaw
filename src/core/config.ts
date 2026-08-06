// ─── Config: paths, settings, CLI detection ──────────

import os from 'os';
import fs from 'fs';
import path from 'path';
import { join } from 'path';
import { DEFAULT_CLI, CLI_KEYS, buildDefaultPerCli } from '../cli/registry.js';
import { pickFirstReadyCli } from '../cli/readiness.js';
import { migrateLegacyClaudeValue } from '../cli/claude-models.js';
import { resolveHomePath } from './path-expand.js';
import { SETUP_STATE_FILE } from './install-integrity.js';
import {
    sanitizeSettingsInput,
    type SettingsPersistenceShape,
} from './settings-merge.js';
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

export const SETTINGS_SCHEMA_VERSION = 3;
export const RUNTIME_DEFAULT_MIGRATION_ID = 'codex-app-default-v2' as const;
export const MULTI_SESSION_DEFAULT_MIGRATION_ID = 'multi-session-default-v3' as const;

export type RuntimeDefaultMigration = {
    id: typeof RUNTIME_DEFAULT_MIGRATION_ID;
    state: 'pending' | 'accepted' | 'kept' | 'already-codex-app';
    fromCli: string;
    toCli: 'codex-app';
};

export type MultiSessionDefaultMigration = {
    id: typeof MULTI_SESSION_DEFAULT_MIGRATION_ID;
    // `already-enabled` is for the opt-in user who turned sessions on before this
    // existed. Offering them a choice they already made would be noise, and accepting
    // on their behalf would change a concurrency they had set deliberately.
    state: 'pending' | 'accepted' | 'kept' | 'already-enabled';
};

// What multiSession meant before this flip. A document written by a schema that predates
// the new defaults must resolve absent keys to these, not to the new ones — otherwise the
// upgrade turns sessions on for someone who never asked (110 §4b-1).
export const LEGACY_MULTI_SESSION_BASELINE = {
    enabled: false,
    maxConcurrent: 1,
    midRunPolicy: 'steer' as const,
    channels: { telegram: false, discord: false, slack: true },
};

function createDefaultSettings() {
    return {
        settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
        runtimeDefaultMigration: null as RuntimeDefaultMigration | null,
        multiSessionDefaultMigration: null as MultiSessionDefaultMigration | null,
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
            inboundDownloadConcurrency: 6,
        },
        messaging: {
            latestSeen: { telegram: null, discord: null, slack: null },
            lastActive: { telegram: null, discord: null, slack: null },
        },
        multiSession: {
            // Sessions are on by default as of schema v3. An existing install does not
            // get this silently: the merge substitutes the legacy baseline for its
            // cohort and asks (110 §4b).
            enabled: true,
            // Two, not more: the observable unit is that a second tab does not wait for
            // the first. Beyond that is the user's CPU and token budget to spend.
            maxConcurrent: 2,
            midRunPolicy: 'steer' as const,
            channels: { telegram: false, discord: false, slack: true },
        },
        // Opt-in Markdown vault (devlog 040). Default OFF and nothing is created on
        // disk until it is explicitly enabled, so a user who never turns it on sees no
        // new directory and no change in behaviour.
        wiki: {
            enabled: false,
            root: '~/jaw-wiki',
            promptDigest: false,
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
        search: { engine: 'like' as 'fts5' | 'like' },
        trace: {
            retentionDays: 7,
            maxRows: 50000,
        },
        runtime: {
            codexApp: {
                multiplex: false,
            },
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

/**
 * The keys a document must carry to legitimately claim the current schema.
 *
 * `cli-jaw init` writes a settings file, so a new install is not the ENOENT case the
 * cohort rules were written around. Left unstamped, its document reads as v1 and the
 * person who just installed is offered a migration away from a state they never had.
 * Stamping the version alone is not enough either — the loader holds a document claiming
 * this schema to what this schema writes — so the writer takes the whole set from here
 * rather than assembling it from memory (110 §4b-3).
 */
export function freshInstallSchemaFields(): {
    settingsSchemaVersion: number;
    multiSession: typeof DEFAULT_SETTINGS.multiSession;
    multiSessionDefaultMigration: MultiSessionDefaultMigration | null;
} {
    // Same question as the loader asks, answered the same way: `init` running against a
    // home that already has a database is re-initialising, not installing.
    const defaults = settingsForHomeWithoutSettingsFile();
    return {
        settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
        multiSession: defaults.multiSession,
        // Null only for a home with no history — there is nothing to migrate from and
        // nothing to ask about. An established home carries the pending marker instead.
        multiSessionDefaultMigration: defaults.multiSessionDefaultMigration,
    };
}

// Things a home only has once someone has set it up or used it. A settings file can be
// deleted, lost to a failed write, or restored from a backup that omitted it — none of
// which makes the install new. These do not come back on their own.
//
// The list errs toward "established" on purpose. Calling a new home established costs a
// question the user did not need to answer; calling an established home new turns a
// feature on for someone who was never asked. Those are not the same mistake. That is
// also why the postinstall-created directories stay in the list even though they can
// precede a first boot.
const ESTABLISHED_HOME_ARTIFACTS = [
    DB_PATH,
    MIGRATION_MARKER,
    PROMPTS_DIR,
    UPLOADS_DIR,
    // `jaw init` leaves all three, and an init-only home whose settings file was then
    // lost is exactly the case that must not read as new.
    join(JAW_HOME, SETUP_STATE_FILE),
    HEARTBEAT_JOBS_PATH,
    SKILLS_DIR,
    WIDGETS_DIR,
];

/**
 * An absent settings file is not proof of a new install, and the difference decides
 * whether sessions start on. Getting it wrong turns a feature on for someone who was
 * never asked, which is the one outcome the whole migration exists to prevent — so the
 * question is answered from the home directory rather than from one file in it.
 */
export function isEstablishedHome(): boolean {
    return ESTABLISHED_HOME_ARTIFACTS.some(path => fs.existsSync(path));
}

/**
 * What a home with no readable settings should start with. A home that has been used
 * before gets the previous meaning plus a pending marker, so it is asked like any other
 * upgrade; only a home with no history at all gets the new defaults.
 */
export function settingsForHomeWithoutSettingsFile(): ReturnType<typeof createDefaultSettings> {
    const next = createDefaultSettings();
    if (!isEstablishedHome()) return next;
    next.multiSession = { ...next.multiSession, ...LEGACY_MULTI_SESSION_BASELINE };
    next.multiSessionDefaultMigration = {
        id: MULTI_SESSION_DEFAULT_MIGRATION_ID,
        state: 'pending',
    };
    return next;
}

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
export function migrateSettings(s: Record<string, any>, sourceVersion = readSettingsSchemaVersion(s)) {
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

    if (sourceVersion === 1) {
        const fromCli = CLI_KEYS.includes(s["cli"]) ? s["cli"] : 'claude';
        s["cli"] = fromCli;
        s["settingsSchemaVersion"] = SETTINGS_SCHEMA_VERSION;
        s["runtimeDefaultMigration"] = {
            id: RUNTIME_DEFAULT_MIGRATION_ID,
            state: fromCli === 'codex-app' ? 'already-codex-app' : 'pending',
            fromCli,
            toCli: 'codex-app',
        } satisfies RuntimeDefaultMigration;
    } else {
        validateRuntimeDefaultMigration(s["runtimeDefaultMigration"]);
    }

    // The session-default flip is its own migration with its own marker. It is NOT
    // folded into the runtime one: the two flips can be rolled back at different times
    // for different reasons, and a shared marker would make that impossible to express.
    // A v1 document crosses both boundaries and so gets both markers in this one pass.
    if (sourceVersion < SETTINGS_SCHEMA_VERSION) {
        s["settingsSchemaVersion"] = SETTINGS_SCHEMA_VERSION;
        s["multiSessionDefaultMigration"] = {
            id: MULTI_SESSION_DEFAULT_MIGRATION_ID,
            // Someone who already turned sessions on made this decision before we asked.
            // Offering it again would be noise, and accepting for them would change a
            // concurrency they chose.
            state: s["multiSession"]?.enabled === true ? 'already-enabled' : 'pending',
        } satisfies MultiSessionDefaultMigration;
    } else {
        validateMultiSessionDefaultMigration(s["multiSessionDefaultMigration"]);
    }

    // A pending marker means the user has not answered yet, so sessions being on
    // contradicts it. The dedicated accept route moves both together, but it is not the
    // only way in: the settings watcher merges an external file write, and a generic
    // settings patch can set `multiSession.enabled` directly. Both strip the marker as
    // server-owned and then leave this pair inconsistent — enabled, and still pending.
    //
    // Resolved by treating an enable while pending AS the answer rather than by refusing
    // it. Someone who reaches in and turns it on has decided; what must not survive is a
    // marker that still claims to be waiting, because the next boot would ask again and
    // the record would no longer mean anything.
    const sessionMigration = s["multiSessionDefaultMigration"] as MultiSessionDefaultMigration | null | undefined;
    if (sessionMigration?.state === 'pending' && s["multiSession"]?.enabled === true) {
        s["multiSessionDefaultMigration"] = { ...sessionMigration, state: 'accepted' };
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
            inboundDownloadConcurrency: 6,
        };
    }
    if (!Number.isInteger(s["slack"].inboundDownloadConcurrency)
        || s["slack"].inboundDownloadConcurrency < 1
        || s["slack"].inboundDownloadConcurrency > 32) {
        s["slack"].inboundDownloadConcurrency = 6;
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
    if (!s["multiSession"]) {
        s["multiSession"] = createDefaultSettings().multiSession;
    } else {
        // Deliberately the OLD defaults, not createDefaultSettings(). This function takes
        // an already-merged object and cannot tell which cohort it came from, so handing
        // out the new defaults here would enable sessions for a legacy document that
        // reached this line by some path other than the boot merge. The boot merge fills
        // both keys from the cohort baseline, which makes these two lines unreachable on
        // the normal path — they are the net under it, and a net set to the new defaults
        // is not a net (110 §4b-2).
        if (s["multiSession"].enabled === undefined) {
            s["multiSession"].enabled = LEGACY_MULTI_SESSION_BASELINE.enabled;
        }
        if (s["multiSession"].maxConcurrent === undefined) {
            s["multiSession"].maxConcurrent = LEGACY_MULTI_SESSION_BASELINE.maxConcurrent;
        }
        if (s["multiSession"].midRunPolicy === undefined) s["multiSession"].midRunPolicy = 'steer';
        if (s["multiSession"].channels === undefined) {
            s["multiSession"].channels = { telegram: false, discord: false, slack: true };
        } else {
            if (s["multiSession"].channels.telegram === undefined) s["multiSession"].channels.telegram = false;
            if (s["multiSession"].channels.discord === undefined) s["multiSession"].channels.discord = false;
            if (s["multiSession"].channels.slack === undefined) s["multiSession"].channels.slack = true;
        }
    }
    const maxConcurrent = Number(s["multiSession"].maxConcurrent);
    s["multiSession"].maxConcurrent = Number.isInteger(maxConcurrent) && maxConcurrent > 0
        ? maxConcurrent
        : 1;
    if (!['steer', 'followup', 'collect', 'interrupt'].includes(s["multiSession"].midRunPolicy)) {
        s["multiSession"].midRunPolicy = 'steer';
    }
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
let settingsPersistenceShape: SettingsPersistenceShape = 'absent';

export type SettingsStateCandidate = {
    value: typeof settings;
    shape: SettingsPersistenceShape;
};

function readSettingsSchemaVersion(raw: Record<string, any>): 1 | 2 | 3 {
    if (!("settingsSchemaVersion" in raw)) return 1;
    const version = raw["settingsSchemaVersion"];
    if (!Number.isInteger(version) || version < 1 || version > SETTINGS_SCHEMA_VERSION) {
        throw new Error(`unsupported_settings_schema_version:${String(version)}`);
    }
    return version as 1 | 2 | 3;
}

function validateRuntimeDefaultMigration(value: unknown): void {
    if (value === null || value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid_runtime_default_migration');
    }
    const migration = value as Record<string, unknown>;
    const keys = Object.keys(migration).sort();
    const expectedKeys = ['fromCli', 'id', 'state', 'toCli'];
    const validState = ['pending', 'accepted', 'kept', 'already-codex-app'].includes(String(migration["state"]));
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
        || migration["id"] !== RUNTIME_DEFAULT_MIGRATION_ID
        || !validState
        || typeof migration["fromCli"] !== 'string'
        || migration["toCli"] !== 'codex-app') {
        throw new Error('invalid_runtime_default_migration');
    }
}

function validateMultiSessionDefaultMigration(value: unknown): void {
    if (value === null || value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid_multi_session_default_migration');
    }
    const migration = value as Record<string, unknown>;
    const keys = Object.keys(migration).sort();
    const validState = ['pending', 'accepted', 'kept', 'already-enabled'].includes(String(migration["state"]));
    if (JSON.stringify(keys) !== JSON.stringify(['id', 'state'])
        || migration["id"] !== MULTI_SESSION_DEFAULT_MIGRATION_ID
        || !validState) {
        throw new Error('invalid_multi_session_default_migration');
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ─── Clobber-protection latch (260806) ───────────────
// When settings.json existed but could not be read at boot (corrupt JSON, an
// unsupported/future schema version, a permission error), the in-memory state is
// defaults — and any later save (messaging.latestSeen, a UI write) would flush those
// defaults over the user's real file, tokens included. That actually happened: a v2
// packaged app read a v3 file and wiped a Slack config. While latched, saves commit
// to memory only and the file on disk is left exactly as it was.
let settingsPersistenceBlockedReason: string | null = null;
let settingsPersistenceBlockedWarned = false;

export function isSettingsPersistenceBlocked(): boolean {
    return settingsPersistenceBlockedReason !== null;
}

/**
 * A v3 document was written by this schema, and this schema always writes both the
 * multiSession block and its migration marker. If either is missing or malformed, the
 * document is not what it claims to be — and the consequence of guessing is specific:
 * an absent block would inherit the new defaults and start running sessions while the
 * marker still said the user had not consented (110 §4b-3). Older documents are held to
 * no such rule: their schema did not know these keys, so absent is normal there and the
 * legacy baseline covers it.
 */
function assertCurrentSchemaSessionShape(raw: Record<string, any>): void {
    const block = raw["multiSession"];
    if (!isPlainRecord(block)) throw new Error('invalid_multi_session_block');
    if (typeof block["enabled"] !== 'boolean') throw new Error('invalid_multi_session_enabled');
    const maxConcurrent = block["maxConcurrent"];
    if (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) < 1) {
        throw new Error('invalid_multi_session_max_concurrent');
    }
    if ('channels' in block && !isPlainRecord(block["channels"])) {
        throw new Error('invalid_multi_session_channels');
    }
    if (!('multiSessionDefaultMigration' in raw)) {
        throw new Error('missing_multi_session_default_migration');
    }
    validateMultiSessionDefaultMigration(raw["multiSessionDefaultMigration"]);
}

export function loadSettings() {
    // A fresh load is a fresh verdict: a successful parse (or a genuinely absent
    // file) below re-enables persistence; only the unreadable-existing-file catch
    // re-arms the latch.
    settingsPersistenceBlockedReason = null;
    settingsPersistenceBlockedWarned = false;
    try {
        let raw: any = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('invalid_settings_document');
        }
        const sanitized = sanitizeSettingsInput(raw, 'boot');
        raw = sanitized.value;
        const nextShape = sanitized.persistenceShape;
        if (sanitized.rejectedPaths.length > 0) {
            console.warn(`[jaw:settings] ignored server-owned settings fields: ${sanitized.rejectedPaths.join(', ')}`);
        }
        if (sanitized.invalidPaths.length > 0) {
            console.warn(`[jaw:settings] ignored invalid settings fields: ${sanitized.invalidPaths.join(', ')}`);
        }
        const sourceVersion = readSettingsSchemaVersion(raw);
        // Dropping a malformed field and carrying on is right for a patch arriving over
        // the API — the rest of the patch is still what the caller meant. It is wrong for
        // a document claiming the current schema at boot: this schema wrote that block,
        // so a malformed one means the file is not what it says, and silently replacing
        // it with defaults is how a pending consent turns into a running feature.
        if (sourceVersion >= 3 && sanitized.invalidPaths.some(path => path.startsWith('multiSession'))) {
            throw new Error(`invalid_multi_session_block:${sanitized.invalidPaths.join(',')}`);
        }
        // A v1 document predates the codex-app default, so an absent or unknown
        // cli is normalised to the historical fallback rather than inheriting
        // the new default. A v2 document was written by this schema and must
        // already name a known runtime; if it does not, the file is not
        // trustworthy enough to silently supply one, so it closes the same way
        // a corrupt or future-versioned document does.
        if (sourceVersion >= 2 && !CLI_KEYS.includes(raw["cli"])) {
            throw new Error(`invalid_settings_cli:${String(raw["cli"])}`);
        }
        // A document claiming the current schema must actually carry what this schema
        // writes. Checked before the merge, because after it the absence is gone.
        if (sourceVersion >= 3) assertCurrentSchemaSessionShape(raw);
        const legacyCli = sourceVersion === 1 && !CLI_KEYS.includes(raw["cli"])
            ? 'claude'
            : raw["cli"];
        const hadPlanning = !!raw.planning;
        const defaults = createDefaultSettings();
        // Everything below the current schema predates the session defaults, so absent
        // keys resolve to what they used to mean rather than to the new defaults. The
        // merge runs before migrateSettings, so this is the only place that still knows
        // whether a key was in the document or is about to be invented (110 §4b-1).
        const multiSessionBaseline = sourceVersion < SETTINGS_SCHEMA_VERSION
            ? LEGACY_MULTI_SESSION_BASELINE
            : defaults.multiSession;
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
            ...(sourceVersion === 1 ? { cli: legacyCli } : {}),
            perCli: mergedPerCli,
            tui: { ...defaults.tui, ...(raw.tui || {}) },
            telegram: { ...defaults.telegram, ...(raw.telegram || {}) },
            discord: { ...defaults.discord, ...(raw.discord || {}) },
            slack: { ...defaults.slack, ...(raw.slack || {}) },
            memory: { ...defaults.memory, ...(raw.memory || {}) },
            search: {
                ...defaults.search,
                ...(raw.search || {}),
                engine: raw.search?.engine === 'fts5' ? 'fts5' : 'like',
            },
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
            runtime: {
                ...defaults.runtime,
                ...(raw.runtime || {}),
                codexApp: {
                    ...defaults.runtime.codexApp,
                    ...(raw.runtime?.codexApp || {}),
                },
            },
            code: { ...defaults.code, ...(raw.code || {}) },
            multiSession: {
                ...multiSessionBaseline,
                ...(raw.multiSession || {}),
                channels: { ...multiSessionBaseline.channels, ...(raw.multiSession?.channels || {}) },
            },
            wiki: { ...defaults.wiki, ...(raw.wiki || {}) },
        }, sourceVersion);
        // #64 safety: auto-correct stale workingDir (e.g. copied instance)
        // but allow valid paths to persist (dynamic project targeting)
        // Any document below the current schema was rewritten by the migration above, so
        // it has to reach disk. Leaving it unsaved would keep memory at v3 while the file
        // stayed older, and the next boot would run the migration again — including
        // recreating a marker the user had already resolved.
        let needsSave = sourceVersion < SETTINGS_SCHEMA_VERSION || hadPlanning;
        if (typeof merged["workingDir"] === 'string' && merged["workingDir"] !== JAW_HOME && !fs.existsSync(merged["workingDir"])) {
            console.warn(`[jaw:workingDir] stale path ${merged["workingDir"]}, resetting to JAW_HOME`);
            merged["workingDir"] = JAW_HOME;
            needsSave = true;
        }

        const candidate = { value: merged, shape: nextShape } satisfies SettingsStateCandidate;
        if (needsSave) persistAndCommit(candidate);
        else commitCandidate(candidate);

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

        return merged;
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
            // ENOENT means no settings file, not necessarily no install. A home that has
            // a database or an uploads directory has been used, so it is treated as an
            // upgrade and asked rather than switched on.
            const next = settingsForHomeWithoutSettingsFile();
            next.cli = pickFirstReadyCli();
            applyEnvOverrides(next);
            persistAndCommit({ value: next, shape: 'absent' });
            return next;
        }

        const next = createDefaultSettings();
        next.cli = 'claude';
        // This branch stands in for a state we could not read — corrupt JSON, an
        // unsupported version, a permission error. The new-install defaults are the wrong
        // thing to borrow here: they would turn sessions on for someone whose real
        // settings might have had them off, and who was never asked. Pinned to what the
        // previous schema meant (110 §4c). The ENOENT branch above is genuinely new and
        // keeps the new defaults.
        next.multiSession = { ...next.multiSession, ...LEGACY_MULTI_SESSION_BASELINE };
        applyEnvOverrides(next);
        commitCandidate({ value: next, shape: 'absent' });

        console.warn(`[jaw:settings] failed to load ${SETTINGS_PATH}: ${err?.message || String(error)}`);
        if (fs.existsSync(SETTINGS_PATH)) {
            // The file is real and we could not read it, so what is in memory now is
            // NOT the user's settings. Latch persistence so no later save clobbers
            // the file; the backup below is a copy, not a license to overwrite.
            settingsPersistenceBlockedReason = err?.message || String(error);
            let backupTimestamp = Date.now();
            let backupPath = `${SETTINGS_PATH}.corrupt-${backupTimestamp}.bak`;
            while (fs.existsSync(backupPath)) {
                backupTimestamp += 1;
                backupPath = `${SETTINGS_PATH}.corrupt-${backupTimestamp}.bak`;
            }
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

export function serializeSettingsForSave(candidate: SettingsStateCandidate): string {
    const value = structuredClone(candidate.value);
    const runtime = value["runtime"];
    if (candidate.shape === 'absent' && runtime?.codexApp?.multiplex === false) {
        delete runtime.codexApp.multiplex;
        if (Object.keys(runtime.codexApp).length === 0) delete runtime.codexApp;
        if (Object.keys(runtime).length === 0) delete value["runtime"];
    }
    return JSON.stringify(value, null, 2);
}

export type SettingsWrite = (raw: string) => void;

function writeSettingsRaw(raw: string): void {
    // settings.json carries live channel tokens (xoxb-/xapp-/bot tokens), so
    // it must never be group/other-readable. writeFileSync's mode applies
    // only at creation — chmod covers the existing-file path.
    fs.writeFileSync(SETTINGS_PATH, raw, { mode: 0o600 });
    if (process.platform !== 'win32') {
        try { fs.chmodSync(SETTINGS_PATH, 0o600); } catch { /* best-effort */ }
    }
}

export function commitCandidate(candidate: SettingsStateCandidate): void {
    settings = candidate.value;
    settingsPersistenceShape = candidate.shape;
}

export function persistAndCommit(
    candidate: SettingsStateCandidate,
    write: SettingsWrite = writeSettingsRaw,
): void {
    if (settingsPersistenceBlockedReason !== null) {
        // Memory-only: the file on disk holds the user's real settings in a shape
        // this binary could not read, and writing would destroy them.
        if (!settingsPersistenceBlockedWarned) {
            settingsPersistenceBlockedWarned = true;
            console.warn(`[jaw:settings] persistence disabled: settings.json was unreadable at boot (${settingsPersistenceBlockedReason}); refusing to overwrite it`);
        }
        commitCandidate(candidate);
        return;
    }
    const raw = serializeSettingsForSave(candidate);
    write(raw);
    lastSavedSettingsRaw = raw;
    commitCandidate(candidate);
}

/** Re-save the current settings pair for legacy callers that mutate settings in place. */
export function saveSettings(s: Record<string, any>) {
    persistAndCommit({ value: s, shape: settingsPersistenceShape });
}

export function snapshotSettingsState(): SettingsStateCandidate {
    return {
        value: structuredClone(settings),
        shape: settingsPersistenceShape,
    };
}

export function getSettingsPersistenceShape(): SettingsPersistenceShape {
    return settingsPersistenceShape;
}

export function getLastSavedSettingsRaw(): string | null {
    return lastSavedSettingsRaw;
}

/** Replace settings object (for API PUT /api/settings deep merge) */
export function replaceSettings(s: Record<string, any>, shape: SettingsPersistenceShape) {
    commitCandidate({ value: s, shape });
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
