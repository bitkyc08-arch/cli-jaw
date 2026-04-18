// ─── cli-jaw Server (glue + routes) ─────────────────
// All business logic lives in src/ modules.

import express from 'express';
import helmet from 'helmet';
import { log } from './src/core/logger.js';
import { createServer } from 'http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import fs from 'fs';

import { registerBrowserRoutes } from './src/routes/browser.js';
import { registerEmployeeRoutes } from './src/routes/employees.js';
import { registerHeartbeatRoutes } from './src/routes/heartbeat.js';
import { registerSkillRoutes } from './src/routes/skills.js';
import { registerJawMemoryRoutes } from './src/routes/jaw-memory.js';
import { registerI18nRoutes } from './src/routes/i18n.js';
import { registerOrchestrateRoutes } from './src/routes/orchestrate.js';
import { registerMemoryRoutes } from './src/routes/memory.js';
import { registerSettingsRoutes } from './src/routes/settings.js';
import { registerMessagingRoutes } from './src/routes/messaging.js';
import { registerAvatarRoutes } from './src/routes/avatar.js';
import {
    ensureWorkingDirSkillsLinks, initMcpConfig, copyDefaultSkills,
} from './lib/mcp-sync.js';

// ─── src/ modules ────────────────────────────────────


import { ok, fail } from './src/http/response.js';

import { errorHandler } from './src/http/error-middleware.js';

import { setWss, broadcast } from './src/core/bus.js';
import { isAllowedHost, isAllowedOrigin, isPrivateIP } from './src/security/network-acl.js';
import { initBossToken } from './src/core/boss-auth.js';
import * as browser from './src/browser/index.js';

import { ensureMemoryRuntimeReady, hasSoulFile } from './src/memory/runtime.js';

import { loadLocales, t, normalizeLocale } from './src/core/i18n.js';
import {
    PROMPTS_DIR, DB_PATH,
    settings, loadSettings, saveSettings,
    ensureDirs, runMigration,
    APP_VERSION,
} from './src/core/config.js';
import {
    db, getSession, getMessages, getMessagesWithTrace, closeDb,
    clearAllEmployeeSessions,
} from './src/core/db.js';
import {
    initPromptFiles, regenerateB,
} from './src/prompt/builder.js';

import {
    isAgentBusy, killAllAgents,
    messageQueue, resetFallbackState,
} from './src/agent/spawn.js';
import { bumpSessionOwnershipGeneration } from './src/agent/session-persistence.js';
import { parseCommand, executeCommand, COMMANDS } from './src/cli/commands.js';

import { getState, resetState } from './src/orchestrator/state-machine.js';
import { resolveOrcScope } from './src/orchestrator/scope.js';
import { listActiveOrcStates } from './src/core/db.js';

import { submitMessage } from './src/orchestrator/gateway.js';

import { makeCommandCtx } from './src/cli/command-context.js';

import './src/discord/bot.js'; // side-effect: registers discord transport
import { initActiveMessagingRuntime, shutdownMessagingRuntime, hydrateTargetsFromSettings } from './src/messaging/runtime.js';

import { startHeartbeat, stopHeartbeat, watchHeartbeatFile } from './src/memory/heartbeat.js';

import { clearMainSessionState, syncMainSessionToSettings, resetSessionPreservingHistory } from './src/core/main-session.js';
import { applyRuntimeSettingsPatch } from './src/core/runtime-settings.js';

import { seedDefaultEmployees } from './src/core/employees.js';
import { buildServicePath } from './src/core/instance.js';

// ─── Resolve paths ───────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk up to project root (where package.json lives)
// Works from both source (server.ts) and dist (dist/server.js)
function findProjectRoot(): string {
    let dir = __dirname;
    while (dir !== dirname(dir)) {
        if (fs.existsSync(join(dir, 'package.json'))) return dir;
        dir = dirname(dir);
    }
    return __dirname; // fallback
}
const projectRoot = findProjectRoot();

// ─── .env loader (no dependency) ─────────────────────

try {
    const envPath = join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^([A-Z_]+)=(.*)$/);
            if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2]!.trim();
        }
    }
} catch { /* no .env, that's fine */ }

process.env.PATH = buildServicePath(process.env.PATH || '');

// ─── Init ────────────────────────────────────────────

const PORT = process.env.PORT || settings.port || 3457;
// DEFAULT_EMPLOYEES + seedDefaultEmployees → src/core/employees.ts

ensureDirs();
fs.mkdirSync(join(projectRoot, 'public'), { recursive: true });
runMigration(projectRoot);
loadSettings();

// DB integrity check on startup
{
    const result = (db.prepare('PRAGMA quick_check').pluck().get()) as string;
    if (result !== 'ok') {
        console.error(`[db] ⚠️  INTEGRITY CHECK FAILED: ${result}`);
        console.error('[db] Database may be corrupted. Consider restoring from backup.');
    }
}

{
    const cleared = clearAllEmployeeSessions.run().changes;
    if (cleared > 0) {
        console.log(`[jaw:startup] cleared ${cleared} stale employee resume session(s)`);
    }
}

// Clean orphaned employee tmp dirs from previous crashes
{
    const { tmpdir } = await import('node:os');
    const tmpBase = tmpdir();
    try {
        const orphans = fs.readdirSync(tmpBase).filter(e => e.startsWith('jaw-emp-'));
        for (const e of orphans) {
            fs.rmSync(join(tmpBase, e), { recursive: true, force: true });
        }
        if (orphans.length) console.log(`[jaw:startup] cleaned ${orphans.length} orphaned employee tmp dir(s)`);
    } catch { /* tmpdir read may fail on restricted systems */ }
}

syncMainSessionToSettings();
try {
    ensureMemoryRuntimeReady();
    console.log('[jaw:startup] memory ready, hasSoul:', hasSoulFile());
} catch (e: unknown) {
    console.warn('[jaw:memory-init]', (e as Error).message);
}

// Phase 3.1: safe → auto 강제 마이그레이션 (기존 사용자 대응)
if (settings.permissions === 'safe') {
    settings.permissions = 'auto';
    saveSettings(settings);
    console.log('[jaw:migrate] permissions: safe → auto');
}

initPromptFiles();
regenerateB();

// Reset stale orchestration state left by unclean shutdown (kill -9, crash)
// Only reset states older than 15 minutes to avoid wiping active orchestrations
{
    const staleRows = (listActiveOrcStates.all() as Array<{ id: string; state: string; updated_at: string }>)
        .filter(row => Date.now() - new Date(row.updated_at).getTime() > 15 * 60_000);
    for (const row of staleRows) {
        console.log(`[jaw:startup] resetting stale orc_state(${row.id}): ${row.state} → IDLE`);
        resetState(row.id);
    }
}

// ─── Express + WebSocket ─────────────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
    server,
    verifyClient: (info, cb) => {
        const host = info.req.headers.host;
        if (host && !isAllowedHost(host, lanAllowed())) {
            return cb(false, 403, 'Host not allowed (LAN bypass disabled)');
        }
        const origin = info.origin || (info.req.headers.origin as string);
        if (origin && !isAllowedOrigin(origin, host, lanAllowed())) {
            return cb(false, 403, 'Origin not allowed');
        }
        cb(true);
    }
});

setWss(wss);

// ─── Security Headers ───────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false, // CDN 사용 중이므로 비활성
    crossOriginEmbedderPolicy: false,
}));

// ─── CORS (loopback always, LAN opt-in) ─────────────
const lanMode = process.env.JAW_LAN_MODE === '1';
const lanAllowed = () => lanMode || settings.network?.lanBypass === true;
const LAN_HINT = 'Set settings.network.bindHost="0.0.0.0" and lanBypass=true to allow LAN access.';

// Host header validation (DNS rebinding defense)
app.use((req, res, next) => {
    const host = req.headers.host;
    if (host && !isAllowedHost(host, lanAllowed())) {
        return res.status(403).json({ error: 'Host not allowed', hint: LAN_HINT });
    }
    next();
});

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, req.headers.host, lanAllowed())) {
        return res.status(403).json({ error: 'Origin not allowed', hint: LAN_HINT });
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Filename,Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ─── Bearer Token Auth (CRITICAL endpoints) ─────────
const JAW_AUTH_TOKEN = process.env.JAW_AUTH_TOKEN || crypto.randomBytes(32).toString('hex');

// Boss-only dispatch token (phase 8). Server generates and stores in process.env;
// main-agent spawns inherit it, employee spawns strip it in makeCleanEnv.
initBossToken();

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const remoteIp = req.ip || req.socket?.remoteAddress || '';
    const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    const isLanBypass = lanAllowed() && isPrivateIP(remoteIp);
    if (isLoopback || isLanBypass) {
        return next();
    }
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (token !== JAW_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Rate Limiting (in-memory, API only, 120/min) ─────────────
const rateLimitMap = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of rateLimitMap) {
        if (now - w.start > 120_000) rateLimitMap.delete(ip);
    }
}, 600_000);
app.use((req, res, next) => {
    // Do not throttle HTML/CSS/JS/image/favicon requests.
    // A single page load can fan out into many static asset requests and
    // self-trigger 429s before the UI even boots.
    if (!req.path.startsWith('/api/')) return next();
    const ip = req.ip;
    const now = Date.now();
    const window = rateLimitMap.get(ip) || { count: 0, start: now };
    if (now - window.start > 60_000) { window.count = 0; window.start = now; }
    window.count++;
    rateLimitMap.set(ip, window);
    if (window.count > 120) return res.status(429).json({ error: 'rate_limit' });
    next();
});

app.use(express.json({ limit: '1mb' }));

// Serve Vite production build (public/dist/index.html) at root when available
const distIndex = join(projectRoot, 'public', 'dist', 'index.html');
app.get('/', (_req, res, next) => {
    if (fs.existsSync(distIndex)) return res.sendFile('dist/index.html', { root: join(projectRoot, 'public') });
    next();
});

app.use(express.static(join(projectRoot, 'public')));

// WebSocket incoming messages
wss.on('connection', (ws) => {
    if (isAgentBusy()) {
        ws.send(JSON.stringify({ type: 'agent_status', status: 'running', agentId: 'active' }));
    }
    if (messageQueue.length > 0) {
        ws.send(JSON.stringify({ type: 'queue_update', pending: messageQueue.length }));
    }
    // Send current PABCD state so page refresh preserves glow
    const webScope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
    const orcState = getState(webScope);
    if (orcState && orcState !== 'IDLE') {
        ws.send(JSON.stringify({ type: 'orc_state', state: orcState, scope: webScope, ts: Date.now() }));
    }

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'send_message' && msg.text) {
                const text = String(msg.text || '').trim();
                if (!text) return;
                console.log(`[ws:in] ${text.slice(0, 80)}`);

                const result = submitMessage(text, { origin: 'web' });
                if (result.action === 'rejected' && result.reason === 'busy') {
                    broadcast('agent_done', {
                        text: t('ws.agentBusy', {}, resolveRequestLocale(null, settings.locale)),
                        error: true,
                    });
                }
            }
            if (msg.type === 'stop') killAllAgents('ws');
        } catch (e) { console.warn('[ws:parse] message parse failed', { preview: String(raw).slice(0, 80) }); }
    });
});

// ─── API Routes ──────────────────────────────────────

function getRuntimeSnapshot() {
    return {
        uptimeSec: Math.floor(process.uptime()),
        activeAgent: isAgentBusy(),
        queuePending: messageQueue.length,
    };
}

function clearSessionState() {
    bumpSessionOwnershipGeneration();
    clearMainSessionState();
}

function resetSessionOnly() {
    bumpSessionOwnershipGeneration();
    resetSessionPreservingHistory();
}

function resolveRequestLocale(req: any, preferred: string | null = null) {
    const fallback = settings.locale || 'ko';
    const direct = typeof preferred === 'string' ? preferred.trim() : '';
    if (direct) return normalizeLocale(direct, fallback);

    const bodyLocale = typeof req?.body?.locale === 'string' ? req.body.locale.trim() : '';
    if (bodyLocale) return normalizeLocale(bodyLocale, fallback);

    const queryLocale = typeof req?.query?.locale === 'string' ? req.query.locale.trim() : '';
    if (queryLocale) return normalizeLocale(queryLocale, fallback);

    const acceptLanguage = typeof req?.headers?.['accept-language'] === 'string'
        ? req.headers['accept-language']
        : '';
    if (acceptLanguage) {
        const primary = acceptLanguage.split(',')[0]?.trim() || '';
        if (primary) return normalizeLocale(primary, fallback);
    }

    return normalizeLocale(fallback, 'ko');
}

async function applySettingsPatch(rawPatch: Record<string, any> = {}) {
    bumpSessionOwnershipGeneration();
    return applyRuntimeSettingsPatch(rawPatch, {
        resetFallbackState,
    });
}

function makeWebCommandCtx(req: any, localeOverride: string | null = null) {
    return makeCommandCtx('web', resolveRequestLocale(req, localeOverride), {
        applySettings: (patch) => applySettingsPatch(patch),
        clearSession: () => clearSessionState(),
        resetSession: () => resetSessionOnly(),
        resetEmployees: () => seedDefaultEmployees({ reset: true, notify: true }),
    });
}

app.get('/api/health', (_req, res) => res.json({ ok: true, version: APP_VERSION, uptime: process.uptime() }));
app.get('/api/session', (_, res) => ok(res, getSession(), getSession() as Record<string, unknown> | undefined));
app.get('/api/messages', (req, res) => {
    const includeTrace = ['1', 'true', 'yes'].includes(String(req.query.includeTrace || '').toLowerCase());
    const rows = includeTrace ? getMessagesWithTrace.all() : getMessages.all();
    ok(res, rows);
});
app.get('/api/runtime', (_, res) => ok(res, getRuntimeSnapshot(), getRuntimeSnapshot()));

// Auth token endpoint — Sec-Fetch-Site guard blocks cross-origin XSS token theft
// Browser-enforced header: cannot be set/spoofed by JS, absent from CLI/curl (passes through)
app.get('/api/auth/token', (req, res) => {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
        return res.status(403).json({ error: 'cross-origin token request blocked' });
    }
    res.json({ token: JAW_AUTH_TOKEN });
});

app.post('/api/command', requireAuth, async (req, res) => {
    try {
        const text = String(req.body?.text || '').trim().slice(0, 500);
        const parsed = parseCommand(text);
        const locale = resolveRequestLocale(req, req.body?.locale);
        res.vary('Accept-Language');
        res.set('Content-Language', locale);
        if (!parsed) {
            return res.status(400).json({
                ok: false,
                code: 'not_command',
                text: t('api.notCommand', {}, locale),
            });
        }
        const result = await executeCommand(parsed, makeWebCommandCtx(req, locale as string));
        res.json(result);
    } catch (err: unknown) {
        console.error('[cmd:error]', err);
        const locale = resolveRequestLocale(req, req.body?.locale);
        res.status(500).json({
            ok: false,
            code: 'internal_error',
            text: t('api.serverError', { msg: (err as Error).message }, locale),
        });
    }
});

app.get('/api/commands', (req, res) => {
    const iface = String(req.query.interface || 'web');
    const locale = resolveRequestLocale(req, req.query.locale as string);
    res.vary('Accept-Language');
    res.set('Content-Language', locale);
    res.json(COMMANDS
        .filter(c => c.interfaces.includes(iface) && !c.hidden)
        .map(c => ({
            name: c.name,
            desc: c.descKey ? t(c.descKey, {}, locale) : c.desc,
            args: c.args || null,
            category: c.category || 'tools',
            aliases: c.aliases || [],
        }))
    );
});

app.post('/api/message', requireAuth, (req, res) => {
    const { prompt } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'prompt required' });

    const result = submitMessage(prompt.trim(), { origin: 'web' });
    if (result.action === 'rejected') {
        // 'busy' / 'duplicate' both return 409 so the client absorbs them silently.
        const status = (result.reason === 'busy' || result.reason === 'duplicate') ? 409 : 400;
        return res.status(status).json({ ok: false, error: result.reason, ...result });
    }
    res.json({ ok: true, ...result });
});

app.post('/api/stop', requireAuth, (req, res) => {
    const killed = killAllAgents('api');
    ok(res, { killed });
});

// UI-only screen clear — broadcasts to all clients but does NOT delete messages
app.post('/api/clear', requireAuth, (_, res) => {
    broadcast('clear', {});
    ok(res, { uiOnly: true });
});

// Explicit session reset — deletes messages (used by /reset confirm, cli-jaw reset)
app.post('/api/session/reset', requireAuth, (_, res) => {
    clearSessionState();
    ok(res, null);
});

// ─── Route modules ───────────────────────────────────
registerEmployeeRoutes(app, requireAuth);
registerHeartbeatRoutes(app, requireAuth);
registerSkillRoutes(app, requireAuth, makeWebCommandCtx);
registerJawMemoryRoutes(app, requireAuth);
registerOrchestrateRoutes(app, requireAuth);
registerMemoryRoutes(app, requireAuth);
registerSettingsRoutes(app, requireAuth, applySettingsPatch, projectRoot);
registerMessagingRoutes(app, requireAuth);
registerAvatarRoutes(app, requireAuth);

// ─── Browser API (Phase 7) — see src/routes/browser.js
registerBrowserRoutes(app, requireAuth);

registerI18nRoutes(app, requireAuth, projectRoot);

// ─── Error Handler (must be last middleware) ─────────
app.use(errorHandler as any);

// ─── Start ───────────────────────────────────────────

watchHeartbeatFile();

// ─── Graceful Shutdown ──────────────────────────────
const shutdown = async (sig: string) => {
    console.log(`\n[server] ${sig} received, shutting down...`);
    stopHeartbeat();
    killAllAgents('shutdown');

    // Reset orchestration state so next startup doesn't show stale P/A/B/C
    const staleRows = listActiveOrcStates.all() as Array<{ id: string }>;
    for (const row of staleRows) resetState(row.id);

    try {
        await Promise.race([
            shutdownMessagingRuntime(),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('messaging_shutdown_timeout')), 2000);
            }),
        ]);
    } catch (e) {
        console.warn('[server] messaging shutdown failed:', (e as Error).message);
    }
    console.log('[server] messaging stopped (or timed out)');

    wss.close();
    server.close();
    if (server.closeAllConnections) server.closeAllConnections();

    // Flush WAL and close SQLite before exiting
    try {
        closeDb();
        console.log('[server] database closed');
    } catch (e) {
        console.warn('[server] database close failed:', (e as Error).message);
    }

    setTimeout(() => {
        console.warn('[server] force exit (timeout)');
        process.exit(1);
    }, 5000).unref();
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

const bindHost: string = lanMode ? '0.0.0.0' : (settings.network?.bindHost || '127.0.0.1');
server.listen(PORT, bindHost, async () => {
    // Persist port so CLI commands auto-discover the running server
    const portStr = String(PORT);
    if (settings.port !== portStr) {
        settings.port = portStr;
        saveSettings(settings);
    }

    // Bootstrap i18n locale dictionaries
    loadLocales(join(projectRoot, 'public', 'locales'));
    log.info(`\n  🦈 Jaw Agent — http://localhost:${PORT}\n`);
    log.info(`  CLI:    ${settings.cli}`);
    log.info(`  Perms:  ${settings.permissions}`);
    log.info(`  CWD:    ${settings.workingDir}`);

    // Warn: lanBypass=true but bindHost=127.0.0.1 → LAN unreachable
    if (settings.network?.lanBypass === true && bindHost === '127.0.0.1' && !lanMode) {
        log.warn('  ⚠ lanBypass is enabled but bindHost is 127.0.0.1 — LAN devices cannot connect.');
        log.warn('    → Set network.bindHost to "0.0.0.0" in settings.json, or use: cli-jaw serve --lan');
    }

    // LAN URL hints + security warnings
    if (bindHost === '0.0.0.0') {
        const { networkInterfaces } = await import('node:os');
        const nets = networkInterfaces();
        const urls: string[] = [];
        for (const iface of Object.values(nets)) {
            for (const net of iface || []) {
                if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${PORT}`);
            }
        }
        if (urls.length) log.info(`  LAN:    ${urls.join(', ')}`);
        if (settings.network?.lanBypass === true) {
            log.warn('  ⚠ LAN auth bypass enabled — only enable on trusted networks.');
        }
    }
    log.info(`  DB:     ${DB_PATH}`);
    log.info(`  Prompts: ${PROMPTS_DIR}`);
    log.info(`  Auth:   ${JAW_AUTH_TOKEN.slice(0, 8)}...\n`);

    // Auto-open browser (opt-in via JAW_OPEN_BROWSER=1, set by `jaw serve --open`)
    // Skip in test environments to prevent browser tabs during npm test
    const isTestEnv = process.env.NODE_ENV === 'test'
        || (process.env.npm_lifecycle_event || '').includes('test');
    if (process.env.JAW_OPEN_BROWSER === '1' && !isTestEnv) {
        const url = `http://localhost:${PORT}`;
        try {
            const openCmd = process.platform === 'darwin' ? 'open'
                : process.platform === 'win32' ? 'cmd'
                    : 'xdg-open';
            const openArgs = process.platform === 'win32'
                ? ['/c', 'start', '', url]
                : [url];
            const opener = spawn(openCmd, openArgs, { detached: true, stdio: 'ignore' });
            opener.on('error', (err) => {
                log.info(`  Browser: could not auto-open (${err.message})`);
            });
            opener.unref();
        } catch (e: unknown) {
            log.info(`  Browser: could not auto-open (${(e as Error).message})`);
        }
    }

    try {
        initMcpConfig(settings.workingDir);
        const symlinks = ensureWorkingDirSkillsLinks(settings.workingDir, { onConflict: 'skip', includeClaude: true, allowReplaceManaged: true });
        copyDefaultSkills();
        const moved = (symlinks?.links || []).filter(x => x.action === 'backup_replace');
        if (moved.length) {
            console.log(`  Skills: moved ${moved.length} conflict path(s) to ~/.cli-jaw/backups/skills-conflicts`);
        }
        console.log(`  MCP:    ~/.cli-jaw/mcp.json`);
    } catch (e: unknown) { console.error('[mcp-init]', (e as Error).message); }

    hydrateTargetsFromSettings(settings);
    try {
        await initActiveMessagingRuntime();
    } catch (e: unknown) {
        console.error('[messaging:boot]', (e as Error).message);
    }

    // ─── Seed default employees if none exist ────────
    const seeded = seedDefaultEmployees();
    if (seeded.seeded > 0) {
        console.log(`  Agents: seeded ${seeded.seeded} default employees (CLI: ${seeded.cli})`);
    }
    startHeartbeat();

    // ─── Migrate Korean agent names → English ────────
    const NAME_MAP = { '프런트': 'Frontend', '프론트': 'Frontend', '백엔드': 'Backend', '데이터': 'Data', '문서': 'Docs', '독스': 'Docs' };
    const allEmps = db.prepare('SELECT id, name FROM employees').all();
    let migrated = 0;
    for (const emp of allEmps) {
        const en = (NAME_MAP as Record<string, string>)[(emp as any).name];
        if (en) { db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(en, (emp as any).id); migrated++; }
    }
    if (migrated > 0) console.log(`  Agents: migrated ${migrated} Korean names → English`);

    // ─── Migrate legacy Claude employee model values → aliases ────────
    const claudeModelMigrations = [
        ['claude-sonnet-4-6', 'sonnet'],
        ['claude-opus-4-6', 'opus'],
        ['claude-sonnet-4-6[1m]', 'sonnet[1m]'],
        ['claude-opus-4-6[1m]', 'opus[1m]'],
    ];
    let empModelMigrated = 0;
    for (const [old, next] of claudeModelMigrations) {
        const r = db.prepare(`UPDATE employees SET model = ? WHERE cli = 'claude' AND model = ?`).run(next, old);
        empModelMigrated += r.changes;
    }
    if (empModelMigrated > 0) console.log(`  Agents: migrated ${empModelMigrated} legacy Claude model values → aliases`);
});
