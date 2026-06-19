// ─── cli-jaw Server (glue + routes) ─────────────────
// All business logic lives in src/ modules.

import express from 'express';
import helmet from 'helmet';
import { log } from './src/core/logger.js';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import fs from 'fs';

import { registerBrowserRoutes } from './src/routes/browser.js';
import { registerCodeRoutes } from './src/routes/code.js';
import { registerEmployeeRoutes } from './src/routes/employees.js';
import { registerHeartbeatRoutes } from './src/routes/heartbeat.js';
import { registerSkillRoutes } from './src/routes/skills.js';
import { registerJawMemoryRoutes } from './src/routes/jaw-memory.js';
import { registerI18nRoutes } from './src/routes/i18n.js';
import { registerOrchestrateRoutes } from './src/routes/orchestrate.js';
import { registerGoalRoutes } from './src/routes/goal.js';
import { registerTaskRoutes } from './src/routes/task.js';
import { registerBgtaskRoutes } from './src/routes/bgtask.js';
import { recoverBgTasks } from './src/bgtask/recover.js';
import { stopAllBgTasks } from './src/bgtask/runner.js';
import { registerEventsRoutes } from './src/routes/events.js';
import { registerInstanceRoutes } from './src/routes/instance.js';
import { registerChatSessionRoutes } from './src/routes/chat-sessions.js';
import { registerStaticRoutes } from './src/routes/static.js';
import { registerMessageRoutes } from './src/routes/messages.js';
import { registerSystemRoutes } from './src/routes/system.js';
import { registerAgentControlRoutes } from './src/routes/agent-control.js';
import { registerCommandRoutes } from './src/routes/command.js';
import { registerGoalRunRoutes } from './src/routes/goal-run.js';
import { registerMemoryRoutes } from './src/routes/memory.js';
import { registerSettingsRoutes } from './src/routes/settings.js';
import { registerMessagingRoutes } from './src/routes/messaging.js';
import { registerAvatarRoutes } from './src/routes/avatar.js';
import { registerTraceRoutes } from './src/routes/traces.js';
import { registerLinkPreviewRoutes } from './src/routes/link-preview.js';
import { registerJawCeoRoutes } from './src/routes/jaw-ceo.js';
import { createRuntimeContextRouter } from './src/routes/runtime-context.js';
import { createSecurityAuditRouter } from './src/routes/security-audit.js';
import { getSecurityAuditLog } from './src/security/security-audit-log.js';
import { createDashboardBoardRouter } from './src/manager/board/routes.js';
import { createDashboardScheduleRouter } from './src/manager/schedule/routes.js';
import {
    ensureWorkingDirSkillsLinks, initMcpConfig, copyDefaultSkills,
} from './lib/mcp-sync.js';

// ─── src/ modules ────────────────────────────────────



import { errorHandler } from './src/http/error-middleware.js';

import { isAllowedHost, isAllowedOrigin, isPrivateIP } from './src/security/network-acl.js';
import { initBossToken } from './src/core/boss-auth.js';
import * as browser from './src/browser/index.js';

import { ensureMemoryRuntimeReady, hasSoulFile } from './src/memory/runtime.js';

import { loadLocales } from './src/core/i18n.js';
import {
    PROMPTS_DIR, DB_PATH,
    settings, loadSettings, saveSettings,
    ensureDirs, runMigration,
} from './src/core/config.js';
import { startSettingsWatch } from './src/core/settings-watch.js';
import {
    db, getLatestAssistantMessage, closeDb,
    clearAllEmployeeSessions,
} from './src/core/db.js';
import { getActiveChatSession } from './src/core/chat-sessions.js';
import { openUrlInBrowser } from './src/core/browser-open.js';
import {
    initPromptFiles, regenerateB,
} from './src/prompt/builder.js';

import { killAllAgents } from './src/agent/spawn.js';
import { resetAllStaleStates } from './src/orchestrator/state-machine.js';

import { submitMessage } from './src/orchestrator/gateway.js';

import { applySettingsPatch } from './src/core/session-ops.js';
import { makeWebCommandCtx } from './src/cli/web-command-ctx.js';

import './src/discord/register.js'; // side-effect: registers discord transport (bot.js + discord.js load lazily on first use)
import { initActiveMessagingRuntime, shutdownMessagingRuntime, hydrateTargetsFromSettings } from './src/messaging/runtime.js';

import { startHeartbeat, stopHeartbeat, watchHeartbeatFile, closeHeartbeatWatcher } from './src/memory/heartbeat.js';
import { initAlertDelivery } from './src/agent/alert-escalation.js';

import {
    getCliModelAndEffort,
    syncMainSessionToSettings,
} from './src/core/main-session.js';

import { seedDefaultEmployees } from './src/core/employees.js';
import { buildServicePath } from './src/core/instance.js';
import { markStaleTraceRunsInterrupted, pruneTraceEvents } from './src/trace/store.js';

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

process.env["PATH"] = buildServicePath(process.env["PATH"] || '');

// ─── Init ────────────────────────────────────────────

ensureDirs();
fs.mkdirSync(join(projectRoot, 'public'), { recursive: true });
runMigration(projectRoot);
loadSettings();

const PORT = process.env["PORT"] || settings["port"] || 3457;

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
if (settings["permissions"] === 'safe') {
    settings["permissions"] = 'auto';
    saveSettings(settings);
    console.log('[jaw:migrate] permissions: safe → auto');
}

initPromptFiles();
regenerateB();

// Reset stale orchestration state left by unclean shutdown (single-scope: default only)
resetAllStaleStates();
markStaleTraceRunsInterrupted();

// Crash-recovery compact: if a session exists but no bootstrap is pending,
// and the last message is >5 min old, generate a bootstrap for context continuity.
try {
    const { peekPendingBootstrapPrompt } = await import('./src/core/main-session.js');
    if (!peekPendingBootstrapPrompt()) {
        const lastMsg = getLatestAssistantMessage.get(getActiveChatSession()) as { created_at?: string } | undefined;
        const lastAt = lastMsg?.created_at ? new Date(lastMsg.created_at).getTime() : 0;
        if (lastAt > 0 && Date.now() - lastAt > 5 * 60_000) {
            const { autoCompactRefresh } = await import('./src/core/compact.js');
            await autoCompactRefresh({
                workDir: settings["workingDir"] || null,
                instructions: '',
                cli: settings["cli"] || 'claude',
                model: settings["model"] || '',
            });
            console.log('[server] crash-recovery compact generated');
        }
    }
} catch {}

// Trace retention: prune on boot + every 6h to keep jaw.db from growing unbounded.
const traceRetentionDays = settings["trace"]?.retentionDays ?? 7;
const traceMaxRows = settings["trace"]?.maxRows ?? 50000;
pruneTraceEvents(traceRetentionDays, traceMaxRows);
setInterval(() => pruneTraceEvents(traceRetentionDays, traceMaxRows), 6 * 60 * 60 * 1000).unref();

// ─── Express ─────────────────────────────────────────

type RemoteAccessSettings = {
    mode?: string;
    trustProxies?: boolean;
    trustForwardedFor?: boolean;
};

const remoteAccess = (settings["network"]?.remoteAccess || {}) as RemoteAccessSettings;
const app = express();
if (remoteAccess.mode === 'reverse-proxy' && remoteAccess.trustProxies && remoteAccess.trustForwardedFor) {
    app.set('trust proxy', 'loopback');
}
const server = createServer(app);
// 65s > any sane client/poller interval; headers > keepAlive per Node
// guidance. Defaults (5s/60s) raced undici connection reuse on transient
// stalls (260613 doc 60).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// ─── Security Headers ───────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false, // CDN 사용 중이므로 비활성
    crossOriginEmbedderPolicy: false,
}));

// ─── CORS (loopback always, LAN opt-in) ─────────────
const lanMode = process.env["JAW_LAN_MODE"] === '1';
const lanAllowed = () => lanMode || settings["network"]?.lanBypass === true;
const LAN_HINT = 'Set settings.network.bindHost="0.0.0.0" and lanBypass=true to allow LAN access.';

// Host header validation (DNS rebinding defense)
app.use((req, res, next) => {
    const host = req.headers.host;
    if (host && !isAllowedHost(host, lanAllowed())) {
        res.status(403).json({ error: 'Host not allowed', hint: LAN_HINT });
        return;
    }
    next();
});

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, req.headers.host, lanAllowed())) {
        res.status(403).json({ error: 'Origin not allowed', hint: LAN_HINT });
        return;
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Filename,Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
});

// ─── Bearer Token Auth (CRITICAL endpoints) ─────────
const JAW_AUTH_TOKEN = process.env["JAW_AUTH_TOKEN"] || crypto.randomBytes(32).toString('hex');

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
    // SSE reconnects must never be locked out by burst traffic from the same
    // IP (all localhost clients — manager polling, CLI, agent — share one
    // bucket). A 429 here extends a drop past the toast grace and the UI
    // reads as "disconnected" while the server is healthy.
    if (req.path === '/api/events') return next();
    // Dispatch pollers (jaw dispatch / worker watch) poll two endpoints every
    // 2s — bounded internal traffic that shares the localhost bucket with the
    // manager scan and the browser. A 429 mid-poll aborts a worker watch for
    // no protective gain (260613 doc 60). Exact poll prefixes only — the
    // workers LIST endpoint stays limited (adversarial review #3).
    if (req.path.startsWith('/api/orchestrate/worker/')
        || req.path.startsWith('/api/orchestrate/worker-progress')) return next();
    const ip = req.ip;
    const now = Date.now();
    const window = rateLimitMap.get(ip) || { count: 0, start: now, logged: false };
    if (now - window.start > 60_000) { window.count = 0; window.start = now; window.logged = false; }
    window.count++;
    rateLimitMap.set(ip, window);
    if (window.count > 120) {
        if (!window.logged) {
            window.logged = true;
            console.warn(`[rate-limit] ${ip} exceeded 120 req/min (first blocked: ${req.method} ${req.path})`);
        }
        return res.status(429).json({ error: 'rate_limit' });
    }
    next();
});

app.use(express.json({ limit: '1mb' }));

// Root + media routes → src/routes/static.ts (Phase 2 extraction).
// Must register BEFORE express.static so GET / prefers the Vite dist build.
registerStaticRoutes(app, requireAuth, { projectRoot });

app.use(express.static(join(projectRoot, 'public')));

// Live updates flow through GET /api/events (SSE) — the legacy WebSocket
// channel was removed in X-01 (devlog 260609, 50). Inbound equivalents:
// send_message → POST /api/message, stop → POST /api/stop.

// ─── API Routes ──────────────────────────────────────
// Phase 2 extraction (devlog 260609, 20): inline handlers/helpers moved to
// src/routes/{system,instance,messages,chat-sessions,static,agent-control}.ts,
// src/http/locale.ts, src/core/session-ops.ts, src/cli/web-command-ctx.ts.

// command/commands/message → src/routes/command.ts (Phase 2 extraction)
// stop/clear/session-reset → src/routes/agent-control.ts (Phase 2 extraction)

// ─── Route modules ───────────────────────────────────
registerEmployeeRoutes(app, requireAuth);
registerHeartbeatRoutes(app, requireAuth);
registerSkillRoutes(app, requireAuth, makeWebCommandCtx);
registerJawMemoryRoutes(app, requireAuth);
registerOrchestrateRoutes(app, requireAuth);
registerGoalRoutes(app, requireAuth);
registerTaskRoutes(app, requireAuth);
registerBgtaskRoutes(app, requireAuth);
registerEventsRoutes(app, requireAuth);
registerInstanceRoutes(app);
registerChatSessionRoutes(app);
registerMessageRoutes(app);
registerSystemRoutes(app, { jawAuthToken: JAW_AUTH_TOKEN });
registerAgentControlRoutes(app, requireAuth);
registerCommandRoutes(app, requireAuth);
registerGoalRunRoutes(app, requireAuth);
registerMemoryRoutes(app, requireAuth);
registerSettingsRoutes(app, requireAuth, applySettingsPatch, projectRoot);
registerMessagingRoutes(app, requireAuth);
registerAvatarRoutes(app, requireAuth);
registerTraceRoutes(app, requireAuth);
registerLinkPreviewRoutes(app, requireAuth);
registerJawCeoRoutes(app, requireAuth, {
    repoRoot: projectRoot,
    listInstances: async () => [{
        port: Number(PORT),
        label: `Jaw :${PORT}`,
        status: 'online',
        ok: true,
        currentCli: settings["cli"] || null,
        currentModel: settings["cli"] ? getCliModelAndEffort(settings["cli"], settings).model : null,
        workingDir: settings["workingDir"] || null,
    }],
    fetchLatestMessage: async (targetPort) => {
        if (targetPort !== Number(PORT)) return null;
        const latestAssistant = getLatestAssistantMessage.get() as { id?: number; role?: string; content?: string | null; created_at?: string } | undefined;
        if (!latestAssistant?.id) return { latestAssistant: null, activity: null };
        return {
            latestAssistant: {
                id: Number(latestAssistant.id),
                role: 'assistant',
                ...(latestAssistant.created_at ? { created_at: String(latestAssistant.created_at) } : {}),
                text: String(latestAssistant.content || ''),
            },
            activity: null,
        };
    },
    sendWorkerMessage: async ({ port: targetPort, prompt }) => {
        if (targetPort === Number(PORT)) {
            const result = submitMessage(prompt.trim(), { origin: 'web' });
            return {
                ok: result.action !== 'rejected',
                message: result.action === 'rejected' ? result.reason || 'rejected' : 'sent',
                data: result,
            };
        }
        const response = await fetch(`http://127.0.0.1:${targetPort}/api/message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const data = await response.json().catch(() => null) as unknown;
        return {
            ok: response.ok,
            status: response.status,
            message: response.ok ? 'sent' : `worker send failed: ${response.status}`,
            data,
        };
    },
});

// ─── Runtime context + Security audit ───────────────
app.use('/api/runtime-context', requireAuth, createRuntimeContextRouter());
app.use('/api/security-audit', createSecurityAuditRouter(requireAuth));

// ─── Dashboard Board / Schedule (P3) ─────────────────
app.use('/api/dashboard/board', requireAuth, createDashboardBoardRouter());
app.use('/api/dashboard/schedule', requireAuth, createDashboardScheduleRouter());

// ─── Browser API (Phase 7) — see src/routes/browser.js
registerBrowserRoutes(app, requireAuth);
// ─── Code mode API (jwc resident ACP host) — see src/routes/code.js
registerCodeRoutes(app, requireAuth);

registerI18nRoutes(app, requireAuth, projectRoot);

// ─── Error Handler (must be last middleware) ─────────
app.use(errorHandler);

// ─── Start ───────────────────────────────────────────

watchHeartbeatFile();

// ─── Graceful Shutdown ──────────────────────────────
const shutdown = async (sig: string) => {
    console.log(`\n[server] ${sig} received, shutting down...`);
    const forceExitTimer = setTimeout(() => {
        console.warn('[server] force exit (timeout)');
        process.exit(1);
    }, 5000);
    forceExitTimer.unref();

    try {
        getSecurityAuditLog().append('service_stop', 'server', { signal: sig, port: PORT });
    } catch { /* non-fatal */ }
    stopHeartbeat();
    closeHeartbeatWatcher();
    try { stopAllBgTasks(); } catch { /* non-fatal */ }
    killAllAgents('shutdown');

    // No longer resetting orc_state on shutdown — 24h staleness filter handles cleanup on startup.
    // Active PABCD sessions should survive graceful restarts.

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

    await new Promise<void>(resolve => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
    });

    // Flush WAL and close SQLite before exiting
    try {
        closeDb();
        console.log('[server] database closed');
    } catch (e) {
        console.warn('[server] database close failed:', (e as Error).message);
    }

    clearTimeout(forceExitTimer);
    process.exit(0);
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[server] FATAL uncaughtException:', err);
    try { closeDb(); } catch {}
    process.exit(1);
});

const cfgBind = settings["network"]?.bindHost || '127.0.0.1';
const isLoopbackBind = cfgBind === '127.0.0.1' || cfgBind === '::1' || cfgBind === 'localhost';
const remoteMode = remoteAccess.mode && remoteAccess.mode !== 'off';
const bindHost: string = lanMode ? '0.0.0.0'
    : (remoteMode && isLoopbackBind) ? '0.0.0.0'
    : cfgBind;
server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[server] port ${PORT} already in use — exiting`);
    } else {
        console.error('[server] listen error:', err.message);
    }
    closeDb();
    process.exit(1);
});
server.listen(PORT, bindHost, async () => {
    // Persist port so CLI commands auto-discover the running server
    const portStr = String(PORT);
    if (settings["port"] !== portStr) {
        settings["port"] = portStr;
        saveSettings(settings);
    }

    // #233: pick up external settings writes (terminal `cli-jaw project set`)
    startSettingsWatch();

    // Bootstrap i18n locale dictionaries
    loadLocales(join(projectRoot, 'public', 'locales'));
    log.info(`\n  🦈 Jaw Agent — http://localhost:${PORT}\n`);
    log.info(`  CLI:    ${settings["cli"]}`);
    log.info(`  Perms:  ${settings["permissions"]}`);
    log.info(`  CWD:    ${settings["workingDir"]}`);

    // Stale PABCD cleanup already runs at module init (line ~195) with 24h filter

    // Warn: lanBypass=true but bindHost=127.0.0.1 → LAN unreachable
    if (settings["network"]?.lanBypass === true && bindHost === '127.0.0.1' && !lanMode) {
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
        if (settings["network"]?.lanBypass === true) {
            log.warn('  ⚠ LAN auth bypass enabled — only enable on trusted networks.');
        }
    }
    log.info(`  DB:     ${DB_PATH}`);
    log.info(`  Prompts: ${PROMPTS_DIR}`);
    const authDesc = lanAllowed()
        ? 'token required for non-LAN requests'
        : 'token required for remote requests (localhost bypassed)';
    log.info(`  Auth:   ${JAW_AUTH_TOKEN.slice(0, 8)}... (${authDesc})`);
    log.info(`  curl:   curl -H "Authorization: Bearer $(cat ~/.cli-jaw/token)" http://localhost:${PORT}/api/status\n`);

    // Auto-open browser (opt-in via JAW_OPEN_BROWSER=1, set by `jaw serve --open`)
    // Skip in test environments to prevent browser tabs during npm test
    const isTestEnv = process.env["NODE_ENV"] === 'test'
        || (process.env["npm_lifecycle_event"] || '').includes('test');
    if (process.env["JAW_OPEN_BROWSER"] === '1' && !isTestEnv) {
        const url = `http://localhost:${PORT}`;
        openUrlInBrowser(url, { logPrefix: 'serve' });
    }

    try {
        initMcpConfig(settings["workingDir"]);
        const symlinks = ensureWorkingDirSkillsLinks(settings["workingDir"], { onConflict: 'skip', includeClaude: true, allowReplaceManaged: true });
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

    try {
        getSecurityAuditLog().append('service_start', 'server', { port: PORT, cli: settings["cli"] });
    } catch { /* non-fatal */ }

    initAlertDelivery();

    // ─── Seed default employees if none exist ────────
    const seeded = seedDefaultEmployees();
    if (seeded.seeded > 0) {
        console.log(`  Agents: seeded ${seeded.seeded} default employees (CLI: ${seeded.cli})`);
    }
    startHeartbeat();
    try {
        const resumed = browser.webAi.resumeStoredWatchers(browser.getActivePort());
        if (resumed.watchers?.length) {
            log.info(`  WebAI: resumed ${resumed.watchers.length} stored watcher(s)`);
        }
    } catch (e: unknown) {
        log.warn(`  WebAI: watcher resume skipped (${(e as Error).message})`);
    }
    recoverBgTasks().catch((e: Error) => log.warn(`  bgtask: recovery skipped (${e.message})`));

    // ─── Migrate Korean agent names → English ────────
    const NAME_MAP: Record<string, string> = { '프런트': 'Frontend', '프론트': 'Frontend', '백엔드': 'Backend', '데이터': 'Data', '문서': 'Docs', '독스': 'Docs' };
    const allEmps = db.prepare('SELECT id, name FROM employees').all() as Array<{ id: string; name: string }>;
    let migrated = 0;
    for (const emp of allEmps) {
        const en = NAME_MAP[emp.name];
        if (en) { db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(en, emp.id); migrated++; }
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
