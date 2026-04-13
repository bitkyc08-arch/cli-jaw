// ─── cli-jaw Server (glue + routes) ─────────────────
// All business logic lives in src/ modules.

import express from 'express';
import helmet from 'helmet';
import { log } from './src/core/logger.js';
import { createServer } from 'http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { validateFileSize, sendTelegramFile } from './src/telegram/telegram-file.js';
import { readClaudeCreds, readCodexTokens, fetchClaudeUsage, fetchCodexUsage, readGeminiAccount } from './src/routes/quota.js';
import { registerBrowserRoutes } from './src/routes/browser.js';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll,
    ensureWorkingDirSkillsLinks, initMcpConfig, copyDefaultSkills,
} from './lib/mcp-sync.js';

// ─── src/ modules ────────────────────────────────────

import { assertSkillId, assertFilename, assertMemoryRelPath, safeResolveUnder } from './src/security/path-guards.js';
import { decodeFilenameSafe } from './src/security/decode.js';
import { ok, fail } from './src/http/response.js';
import { asyncHandler } from './src/http/async-handler.js';
import { errorHandler } from './src/http/error-middleware.js';
import { readCodexContextWindow } from './src/core/codex-config.js';
import { setWss, broadcast } from './src/core/bus.js';
import * as browser from './src/browser/index.js';
import * as memory from './src/memory/memory.js';
import { bootstrapMemory, ensureMemoryRuntimeReady, getMemoryStatus, listMemoryFiles, readIndexedMemorySnippet, reindexMemory, searchIndexedMemory, syncKvShadowImport } from './src/memory/runtime.js';
import { loadLocales, t, normalizeLocale } from './src/core/i18n.js';
import {
    JAW_HOME, PROMPTS_DIR, DB_PATH, UPLOADS_DIR,
    SKILLS_DIR, SKILLS_REF_DIR,
    settings, loadSettings, saveSettings,
    ensureDirs, runMigration,
    loadHeartbeatFile, saveHeartbeatFile,
    detectAllCli, APP_VERSION,
} from './src/core/config.js';
import {
    db, getSession, insertMessage, getMessages, getMessagesWithTrace,
    getRecentMessages,
    getMemory, upsertMemory, deleteMemory,
    getEmployees, insertEmployee, deleteEmployee,
} from './src/core/db.js';
import {
    initPromptFiles, getMemoryDir, getSystemPrompt, regenerateB,
    A2_PATH, HEARTBEAT_PATH,
    getMergedSkills,
} from './src/prompt/builder.js';
import { clearTemplateCache, getTemplateDir } from './src/prompt/template-loader.js';
import {
    activeProcess, isAgentBusy, killActiveAgent, killAllAgents, waitForProcessEnd,
    steerAgent, enqueueMessage, processQueue, messageQueue,
    saveUpload, memoryFlushCounter, resetFallbackState,
} from './src/agent/spawn.js';
import { bumpSessionOwnershipGeneration } from './src/agent/session-persistence.js';
import { parseCommand, executeCommand, COMMANDS } from './src/cli/commands.js';
import { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } from './src/orchestrator/pipeline.js';
import { getState, getCtx, setState, resetState, canTransition } from './src/orchestrator/state-machine.js';
import { resolveOrcScope } from './src/orchestrator/scope.js';
import { listActiveOrcStates } from './src/core/db.js';
import type { OrcStateName } from './src/orchestrator/state-machine.js';
import { submitMessage } from './src/orchestrator/gateway.js';
import { getActiveWorkers, claimWorker, finishWorker, failWorker, markWorkerReplayed } from './src/orchestrator/worker-registry.js';
import { findEmployee, runSingleAgent } from './src/orchestrator/distribute.js';
import { makeCommandCtx } from './src/cli/command-context.js';
import { initTelegram, telegramBot, telegramActiveChatIds } from './src/telegram/bot.js';
import './src/discord/bot.js'; // side-effect: registers discord transport
import { initActiveMessagingRuntime, shutdownMessagingRuntime, hydrateTargetsFromSettings } from './src/messaging/runtime.js';
import { sendChannelOutput, normalizeChannelSendRequest } from './src/messaging/send.js';
import { startHeartbeat, stopHeartbeat, watchHeartbeatFile } from './src/memory/heartbeat.js';
import { validateHeartbeatScheduleInput } from './src/memory/heartbeat-schedule.js';
import { fetchCopilotQuota, refreshCopilotFromKeychain } from './lib/quota-copilot.js';
import { CLI_REGISTRY } from './src/cli/registry.js';
import { clearMainSessionState, syncMainSessionToSettings, resetSessionPreservingHistory } from './src/core/main-session.js';
import { applyRuntimeSettingsPatch } from './src/core/runtime-settings.js';
import { getDefaultClaudeModel, migrateLegacyClaudeValue } from './src/cli/claude-models.js';
import { DEFAULT_EMPLOYEES, seedDefaultEmployees } from './src/core/employees.js';

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

// ─── Init ────────────────────────────────────────────

const PORT = process.env.PORT || settings.port || 3457;
// DEFAULT_EMPLOYEES + seedDefaultEmployees → src/core/employees.ts

ensureDirs();
fs.mkdirSync(join(projectRoot, 'public'), { recursive: true });
runMigration(projectRoot);
loadSettings();
syncMainSessionToSettings();
try {
    ensureMemoryRuntimeReady();
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
{
    const staleRows = listActiveOrcStates.all() as Array<{ id: string; state: string }>;
    for (const row of staleRows) {
        console.log(`[jaw:startup] resetting stale orc_state(${row.id}): ${row.state} → IDLE`);
        resetState(row.id);
    }
}

// ─── Express + WebSocket ─────────────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

setWss(wss);

// ─── Security Headers ───────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false, // CDN 사용 중이므로 비활성
    crossOriginEmbedderPolicy: false,
}));

// ─── CORS (localhost only) ──────────────────────────
const ALLOWED_ORIGINS = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
]);
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Filename');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ─── Rate Limiting (in-memory, 120/min) ─────────────
const rateLimitMap = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of rateLimitMap) {
        if (now - w.start > 120_000) rateLimitMap.delete(ip);
    }
}, 600_000);
app.use((req, res, next) => {
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

                const result = submitMessage(text, { origin: 'cli' });
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

function getLatestTelegramChatId() {
    const ids = Array.from(telegramActiveChatIds);
    return ids.at(-1) || null;
}

async function applySettingsPatch(rawPatch: Record<string, any> = {}) {
    bumpSessionOwnershipGeneration();
    return applyRuntimeSettingsPatch(rawPatch, {
        resetFallbackState,
    });
}

function normalizeAdvancedReadPath(file: string) {
    const value = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return value.startsWith('structured/') ? value.slice('structured/'.length) : value;
}

// seedDefaultEmployees → src/core/employees.ts

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

app.post('/api/command', async (req, res) => {
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

app.post('/api/message', (req, res) => {
    const { prompt } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'prompt required' });

    const result = submitMessage(prompt.trim(), { origin: 'web' });
    if (result.action === 'rejected') {
        return res.status(result.reason === 'busy' ? 409 : 400)
            .json({ error: result.reason });
    }
    res.json({ ok: true, ...result });
});

app.post('/api/orchestrate/continue', (req, res) => {
    if (isAgentBusy()) {
        return res.status(409).json({ error: 'agent already running' });
    }
    orchestrateContinue({ origin: 'web' });
    res.json({ ok: true });
});

app.post('/api/orchestrate/reset', async (req, res) => {
    try {
        await orchestrateReset({ origin: 'web' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[orchestrate:reset] error', err);
        res.status(500).json({ ok: false, error: String(err) });
    }
});

app.get('/api/orchestrate/state', (_req, res) => {
    const scope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
    res.json({ scope, state: getState(scope), ctx: getCtx(scope) });
});

app.get('/api/orchestrate/workers', (_req, res) => {
    res.json(getActiveWorkers());
});

app.get('/api/orchestrate/snapshot', (_req, res) => {
    const runtime = getRuntimeSnapshot();
    const scope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
    res.json({
        orc: { scope, state: getState(scope), ctx: getCtx(scope) },
        runtime: {
            ...runtime,
            busy: runtime.activeAgent || getActiveWorkers().some(w => w.state === 'running'),
        },
        workers: getActiveWorkers(),
    });
});

// ─── Dispatch: pipe-mode employee dispatch ──────────
app.post('/api/orchestrate/dispatch', async (req, res) => {
    if (String(req.headers['x-jaw-dispatch-source'] || '').toLowerCase() === 'employee') {
        return fail(res, 409, 'Employee self-dispatch is blocked in employee sessions');
    }
    const { agent: agentName, task } = req.body || {};
    if (!agentName || !task) return fail(res, 400, 'Missing agent or task');

    const emps = getEmployees.all() as Record<string, any>[];
    const emp = findEmployee(emps, { agent: agentName });
    if (!emp) return fail(res, 404, `Employee not found: ${agentName}`);

    const slot = claimWorker(emp, task);
    try {
        const ap = {
            agent: emp.name, role: emp.role || 'general developer',
            task, parallel: false,
            currentPhase: 3, currentPhaseIdx: 0,
            phaseProfile: [3],
        };
        const result = await runSingleAgent(ap, emp, {}, 1, { origin: 'api' }, []);
        finishWorker(slot.agentId, result.text || '');
        markWorkerReplayed(slot.agentId);
        res.json({ ok: true, result });
    } catch (err: any) {
        failWorker(slot.agentId, err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.put('/api/orchestrate/state', (req, res) => {
    const target = String(req.body?.state || '').toUpperCase();
    const valid: OrcStateName[] = ['P', 'A', 'B', 'C', 'D'];
    if (!valid.includes(target as OrcStateName)) return fail(res, 400, `Invalid state: ${target}. Must be one of: ${valid.join(', ')}`);
    const scope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
    const current = getState(scope);
    const t = target as OrcStateName;
    if (!canTransition(current, t)) {
        return fail(res, 409, `Cannot transition: ${current} → ${t}`);
    }
    if (t === 'D') {
        setState(t, undefined, scope, 'Done');
        resetState(scope);
    } else {
        setState(
            t,
            t === 'P' ? { originalPrompt: '', workingDir: settings.workingDir || null, plan: null, workerResults: [], origin: 'api' } : undefined,
            scope,
            t === 'P' ? 'P' : t,
        );
    }
    res.json({ ok: true, state: getState(scope) });
});

app.post('/api/stop', (req, res) => {
    const killed = killAllAgents('api');
    ok(res, { killed });
});

app.post('/api/clear', (_, res) => {
    clearSessionState();
    ok(res, null);
});

// Settings
app.get('/api/settings', (_, res) => {
    const safe = { ...settings };
    if (safe.stt) {
        const gKey = safe.stt.geminiApiKey || process.env.GEMINI_API_KEY || '';
        const oKey = safe.stt.openaiApiKey || '';
        safe.stt = { ...safe.stt, geminiApiKey: undefined, geminiKeySet: !!gKey, geminiKeyLast4: gKey.slice(-4) || '', openaiApiKey: undefined, openaiKeySet: !!oKey, openaiKeyLast4: oKey.slice(-4) || '' };
    }
    ok(res, safe, safe);
});
app.put('/api/settings', asyncHandler(async (req, res) => {
    const result = await applySettingsPatch(req.body);
    const safe = { ...result };
    if (safe.stt) {
        const gKey2 = safe.stt.geminiApiKey || process.env.GEMINI_API_KEY || '';
        const oKey2 = safe.stt.openaiApiKey || '';
        safe.stt = { ...safe.stt, geminiApiKey: undefined, geminiKeySet: !!gKey2, geminiKeyLast4: gKey2.slice(-4) || '', openaiApiKey: undefined, openaiKeySet: !!oKey2, openaiKeyLast4: oKey2.slice(-4) || '' };
    }
    ok(res, safe);
}));

app.get('/api/memory/status', (_req, res) => {
    res.json(getMemoryStatus());
});
app.post('/api/memory/reindex', (_req, res) => {
    const result = reindexMemory();
    res.json({
        ok: true,
        message: 'Memory reindex completed.',
        result,
        status: getMemoryStatus(),
    });
});
app.post('/api/memory/bootstrap', (req, res) => {
    const result = bootstrapMemory(req.body || {});
    res.json({
        ok: true,
        message: 'Memory bootstrap completed.',
        result,
        status: getMemoryStatus(),
    });
});
app.get('/api/memory/files', (_req, res) => {
    res.json(listMemoryFiles());
});

// Codex context window config
app.get('/api/codex-context', (_, res) => {
    res.json(readCodexContextWindow());
});

// Prompts (A-2)
app.get('/api/prompt', (_, res) => {
    const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
    res.json({ content: a2 });
});
app.put('/api/prompt', (req, res) => {
    const { content } = req.body;
    if (content == null) return res.status(400).json({ error: 'content required' });
    fs.writeFileSync(A2_PATH, content);
    regenerateB();
    res.json({ ok: true });
});

// Prompt Templates (Node Map + Editor)
app.get('/api/prompt-templates', (_, res) => {
    const dir = getTemplateDir();
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.md'));
    const templates = files.map((f: string) => ({
        id: f.replace('.md', ''),
        filename: f,
        content: fs.readFileSync(join(dir, f), 'utf8'),
    }));
    const tree = [
        {
            id: 'system', label: 'getSystemPrompt()', emoji: '🟢',
            children: ['a1-system', 'a2-default', 'orchestration', 'skills', 'heartbeat-jobs', 'heartbeat-default', 'vision-click']
        },
        {
            id: 'employee', label: 'getEmployeePrompt()', emoji: '🟡',
            children: ['employee', 'worker-context']
        },
    ];
    res.json({ templates, tree });
});
app.put('/api/prompt-templates/:id', (req, res) => {
    const { content } = req.body;
    if (content == null || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    const filename = req.params.id + '.md';
    if (!/^[a-z0-9-]+\.md$/.test(filename)) return res.status(400).json({ error: 'invalid id' });
    const dir = getTemplateDir();
    fs.writeFileSync(join(dir, filename), content);
    const srcDir = join(projectRoot, 'src/prompt/templates');
    if (fs.existsSync(srcDir)) fs.writeFileSync(join(srcDir, filename), content);
    clearTemplateCache();
    regenerateB();
    res.json({ ok: true });
});

// HEARTBEAT.md
app.get('/api/heartbeat-md', (_, res) => {
    const content = fs.existsSync(HEARTBEAT_PATH) ? fs.readFileSync(HEARTBEAT_PATH, 'utf8') : '';
    res.json({ content });
});
app.put('/api/heartbeat-md', (req, res) => {
    const { content } = req.body;
    if (content == null) return res.status(400).json({ error: 'content required' });
    fs.writeFileSync(HEARTBEAT_PATH, content);
    res.json({ ok: true });
});

// Memory (key-value)
app.get('/api/memory', (_, res) => ok(res, getMemory.all()));
app.post('/api/memory', (req, res) => {
    const { key, value, source = 'manual' } = req.body;
    if (!key || !value) return fail(res, 400, 'key and value required');
    upsertMemory.run(key, value, source);
    try { syncKvShadowImport(); } catch { /* best-effort */ }
    ok(res, null);
});
app.delete('/api/memory/:key', (req, res) => {
    deleteMemory.run(req.params.key);
    try { syncKvShadowImport(); } catch { /* best-effort */ }
    ok(res, null);
});

// Memory files (Claude native)
app.get('/api/memory-files', (_, res) => {
    const memDir = getMemoryDir();
    const files = memory.list()
        .sort((a, b) => b.path.localeCompare(a.path))
        .map(f => {
            const fullPath = safeResolveUnder(memDir, f.path);
            const content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
            const entries = content.split(/^## /m).filter(Boolean).length;
            return { name: f.path, entries, size: f.size };
        });
    res.json({
        enabled: settings.memory?.enabled !== false,
        flushEvery: settings.memory?.flushEvery ?? 10,
        cli: settings.memory?.cli || '',
        model: settings.memory?.model || '',
        retentionDays: settings.memory?.retentionDays ?? 30,
        path: memDir, files,
        counter: memoryFlushCounter,
    });
});
app.get('/api/memory-file', (req, res) => {
    try {
        const name = assertMemoryRelPath(String(req.query.path || ''), { allowExt: ['.md', '.txt', '.json'] });
        const fp = safeResolveUnder(getMemoryDir(), name);
        if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
        res.json({ name, content: fs.readFileSync(fp, 'utf8') });
    } catch (e: unknown) {
        res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
    }
});
app.get('/api/memory-files/:filename', (req, res) => {
    try {
        const name = assertFilename(req.params.filename);
        const fp = safeResolveUnder(getMemoryDir(), name);
        if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
        res.json({ name, content: fs.readFileSync(fp, 'utf8') });
    } catch (e: unknown) {
        res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
    }
});
app.delete('/api/memory-file', (req, res) => {
    try {
        const name = assertMemoryRelPath(String(req.query.path || ''), { allowExt: ['.md', '.txt', '.json'] });
        const fp = safeResolveUnder(getMemoryDir(), name);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        res.json({ ok: true });
    } catch (e: unknown) {
        res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
    }
});
app.delete('/api/memory-files/:filename', (req, res) => {
    try {
        const name = assertFilename(req.params.filename);
        const fp = safeResolveUnder(getMemoryDir(), name);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        res.json({ ok: true });
    } catch (e: unknown) {
        res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
    }
});
app.put('/api/memory-files/settings', (req, res) => {
    const patch = { ...(req.body || {}) };
    const targetCli = typeof patch.cli === 'string' && patch.cli
        ? patch.cli
        : settings.memory?.cli || settings.cli || '';
    if (targetCli === 'claude' && typeof patch.model === 'string') {
        patch.model = migrateLegacyClaudeValue(patch.model);
    }
    settings.memory = { ...settings.memory, ...patch };
    saveSettings(settings);
    res.json({ ok: true });
});

// File upload
app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    try {
        const filename = decodeFilenameSafe(req.headers['x-filename'] as string | undefined);
        const filePath = saveUpload(req.body, filename);
        res.json({ path: filePath, filename: basename(filePath) });
    } catch (e: unknown) {
        res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
    }
});

// Voice STT endpoint — receives raw audio blob, transcribes, submits as message
app.post('/api/voice', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '20mb' }), async (req, res) => {
    try {
        const ext = (req.headers['x-voice-ext'] as string) || '.webm';
        const mime = req.headers['content-type'] || 'audio/webm';
        const filePath = saveUpload(req.body, `voice${ext}`);

        const { transcribeVoice } = await import('./lib/stt.js');
        const result = await transcribeVoice(filePath, mime);

        if (!result.text.trim()) {
            return res.status(422).json({ error: 'Empty transcription' });
        }

        console.log(`[web:voice] STT (${result.engine}, ${result.elapsed.toFixed(1)}s): ${result.text.slice(0, 80)}`);

        const sttOnly = String(req.headers['x-stt-only'] || '') === 'true';
        if (!sttOnly) {
            const prompt = `🎤 ${result.text}`;
            submitMessage(prompt, { origin: 'web' });
        }

        res.json({ ok: true, text: result.text, engine: result.engine, elapsed: result.elapsed });
    } catch (e: unknown) {
        console.error('[web:voice] STT failed:', (e as Error).message);
        res.status(500).json({ error: (e as Error).message });
    }
});

// Telegram direct send (Phase 2.1)
app.post('/api/telegram/send', async (req, res) => {
    try {
        if (!telegramBot) return res.status(503).json({ error: 'Telegram not connected' });

        const type = String(req.body?.type || '').trim().toLowerCase();
        const supportedTypes = new Set(['text', 'voice', 'photo', 'document']);
        if (!supportedTypes.has(type)) {
            return res.status(400).json({ error: 'type must be one of: text, voice, photo, document' });
        }

        const chatId = req.body?.chat_id || getLatestTelegramChatId();
        if (!chatId) return res.status(400).json({ error: 'chat_id required (or send a Telegram message first)' });

        if (type === 'text') {
            const text = String(req.body?.text || '').trim();
            if (!text) return res.status(400).json({ error: 'text required for type=text' });
            await telegramBot.api.sendMessage(chatId, text);
            return res.json({ ok: true, chat_id: chatId, type });
        }

        const filePath = String(req.body?.file_path || '').trim();
        if (!filePath) return res.status(400).json({ error: 'file_path required for non-text types' });
        if (!fs.existsSync(filePath)) return res.status(400).json({ error: `file not found: ${filePath}` });

        // Validate file size before upload attempt
        validateFileSize(filePath, type);

        const caption = req.body?.caption ? String(req.body.caption) : undefined;
        const result = await sendTelegramFile(telegramBot, chatId, filePath, type, { caption });

        if (!result.ok) {
            const sc = result.statusCode || 502;
            return res.status(sc).json({
                error: result.error, attempts: result.attempts,
                ...(result.retryAfter != null && { retry_after: result.retryAfter }),
            });
        }
        return res.json({ ok: true, chat_id: chatId, type, attempts: result.attempts });
    } catch (e: unknown) {
        console.error('[telegram:send]', e);
        const statusCode = (e as any).statusCode || 500;
        return res.status(statusCode).json({ error: (e as Error).message, code: (e as any).code });
    }
});

// Canonical channel send (Phase 2)
app.post('/api/channel/send', async (req, res) => {
    try {
        const result = await sendChannelOutput(normalizeChannelSendRequest(req.body));
        if (!result.ok) return res.status(502).json(result);
        return res.json(result);
    } catch (e: unknown) {
        console.error('[channel:send]', e);
        return res.status(500).json({ error: (e as Error).message });
    }
});

app.post('/api/discord/send', async (req, res) => {
    try {
        const result = await sendChannelOutput({ ...normalizeChannelSendRequest(req.body), channel: 'discord' });
        if (!result.ok) return res.status(502).json(result);
        return res.json(result);
    } catch (e: unknown) {
        console.error('[discord:send]', e);
        return res.status(500).json({ error: (e as Error).message });
    }
});

// MCP
app.get('/api/mcp', (req, res) => res.json(loadUnifiedMcp()));
app.put('/api/mcp', (req, res) => {
    const config = req.body;
    if (!config || !config.servers) return res.status(400).json({ error: 'servers object required' });
    saveUnifiedMcp(config);
    res.json({ ok: true, servers: Object.keys(config.servers) });
});
app.post('/api/mcp/sync', (req, res) => {
    const config = loadUnifiedMcp();
    const results = syncToAll(config);
    res.json({ ok: true, results });
});
app.post('/api/mcp/install', async (req, res) => {
    try {
        const config = loadUnifiedMcp();
        const { installMcpServers } = await import('./lib/mcp-sync.js');
        const results = await installMcpServers(config);
        saveUnifiedMcp(config);
        const syncResults = syncToAll(config);
        res.json({ ok: true, results, synced: syncResults });
    } catch (e: unknown) {
        console.error('[mcp:install]', e);
        res.status(500).json({ error: (e as Error).message });
    }
});
app.post('/api/mcp/reset', (req, res) => {
    try {
        const mcpPath = join(JAW_HOME, 'mcp.json');
        if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);
        const config = initMcpConfig(settings.workingDir);
        const results = syncToAll(config);
        res.json({
            ok: true,
            servers: Object.keys(config.servers),
            count: Object.keys(config.servers).length,
            synced: results,
        });
    } catch (e: unknown) {
        console.error('[mcp:reset]', e);
        res.status(500).json({ error: (e as Error).message });
    }
});

// CLI & Quota
app.get('/api/cli-registry', (_, res) => res.json(CLI_REGISTRY));
app.get('/api/cli-status', (_, res) => res.json(detectAllCli()));
app.get('/api/quota', async (_, res) => {
    const claudeCreds = readClaudeCreds();
    const codexTokens = readCodexTokens();
    const [claudeResult, codexResult, copilotResult] = await Promise.all([
        fetchClaudeUsage(claudeCreds),
        fetchCodexUsage(codexTokens),
        fetchCopilotQuota(),
    ]);
    const geminiResult = readGeminiAccount();

    // null → { authenticated: false } if no creds, { error: true } if API failure
    const classify = (result: any, hasCreds: boolean) =>
        result ?? (hasCreds ? { error: true } : { authenticated: false });

    res.json({
        claude: classify(claudeResult, !!claudeCreds),
        codex: classify(codexResult, !!codexTokens),
        gemini: geminiResult ?? { authenticated: false },
        opencode: { authenticated: true },
        copilot: copilotResult ?? { authenticated: false },
    });
});

// Copilot: force keychain re-read (clears _keychainFailed suppression)
app.post('/api/copilot/refresh', async (_, res) => {
    try {
        const result = await refreshCopilotFromKeychain();
        res.json(result);
    } catch (e: unknown) {
        res.status(500).json({ ok: false, error: (e as Error).message });
    }
});

// Employees
app.get('/api/employees', (_, res) => ok(res, getEmployees.all()));
app.post('/api/employees', (req, res) => {
    const id = crypto.randomUUID();
    const { name = 'New Agent', cli = 'claude', model = 'default', role = '' } = req.body || {};
    const nextModel = cli === 'claude' && (!model || model === 'default')
        ? getDefaultClaudeModel()
        : model;
    insertEmployee.run(id, name, cli, nextModel, role);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as Record<string, any>;
    broadcast('agent_added', emp);
    regenerateB();
    res.json(emp);
});
app.put('/api/employees/:id', (req, res) => {
    const updates = req.body;
    const allowed = ['name', 'cli', 'model', 'role', 'status'];
    const sets = Object.keys(updates).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (sets.length === 0) return res.status(400).json({ error: 'no valid fields' });
    const vals = sets.map((_, i) => (updates as Record<string, any>)[Object.keys(updates).filter(k => allowed.includes(k))[i]!]);
    db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id) as Record<string, any>;
    broadcast('agent_updated', emp);
    regenerateB();
    res.json(emp);
});
app.delete('/api/employees/:id', (req, res) => {
    deleteEmployee.run(req.params.id);
    broadcast('agent_deleted', { id: req.params.id });
    regenerateB();
    res.json({ ok: true });
});

// Employee reset — delete all + re-seed 5 defaults
app.post('/api/employees/reset', (req, res) => {
    const { seeded } = seedDefaultEmployees({ reset: true, notify: true });
    res.json({ ok: true, seeded });
});

// Heartbeat API
app.get('/api/heartbeat', (req, res) => res.json(loadHeartbeatFile()));
app.put('/api/heartbeat', (req, res) => {
    const data = req.body;
    if (!data || !Array.isArray(data.jobs)) return res.status(400).json({ error: 'jobs array required' });
    const normalizedJobs = [];
    const idPrefix = `hb_${Date.now()}`;
    for (const [index, rawJob] of data.jobs.entries()) {
        const job = (rawJob && typeof rawJob === 'object') ? rawJob as Record<string, unknown> : {};
        const scheduleResult = validateHeartbeatScheduleInput(job.schedule);
        const jobId = typeof job.id === 'string' && job.id.trim()
            ? job.id.trim()
            : `${idPrefix}_${index}`;
        if (!scheduleResult.ok) {
            return res.status(400).json({
                error: 'invalid heartbeat schedule',
                code: scheduleResult.code,
                detail: scheduleResult.error,
                index,
                jobId,
            });
        }
        normalizedJobs.push({
            id: jobId,
            name: typeof job.name === 'string' ? job.name : '',
            enabled: job.enabled !== false,
            schedule: scheduleResult.schedule,
            prompt: typeof job.prompt === 'string' ? job.prompt : '',
        });
    }
    const payload = { jobs: normalizedJobs };
    saveHeartbeatFile(payload);
    startHeartbeat();
    res.json(payload);
});

// ─── Skills API (Phase 6) ────────────────────────────

app.get('/api/skills', (req, res) => {
    const lang = (String(req.query.locale || 'ko')).toLowerCase();
    const skills = getMergedSkills().map(s => ({
        ...s,
        name: s[`name_${lang}`] || s.name,
        description: s[`desc_${lang}`] || s.description,
    }));
    res.json(skills);
});

app.post('/api/skills/enable', (req, res) => {
    try {
        const id = assertSkillId(req.body?.id);
        const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');
        const dstDir = join(SKILLS_DIR, id);
        const dstPath = join(dstDir, 'SKILL.md');
        if (fs.existsSync(dstPath)) return res.json({ ok: true, msg: 'already enabled' });
        if (!fs.existsSync(refPath)) return res.status(404).json({ error: 'skill not found in ref' });
        fs.cpSync(join(SKILLS_REF_DIR, id), dstDir, { recursive: true });
        regenerateB();
        res.json({ ok: true });
    } catch (e: unknown) {
        res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
    }
});

app.post('/api/skills/disable', (req, res) => {
    try {
        const id = assertSkillId(req.body?.id);
        const dstDir = join(SKILLS_DIR, id);
        if (!fs.existsSync(dstDir)) return res.json({ ok: true, msg: 'already disabled' });
        fs.rmSync(dstDir, { recursive: true });
        regenerateB();
        res.json({ ok: true });
    } catch (e: unknown) {
        res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
    }
});

app.get('/api/skills/:id', (req, res) => {
    try {
        const id = assertSkillId(req.params.id);
        const activePath = join(SKILLS_DIR, id, 'SKILL.md');
        const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');
        const p = fs.existsSync(activePath) ? activePath : refPath;
        if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
        res.type('text/markdown').send(fs.readFileSync(p, 'utf8'));
    } catch (e: unknown) {
        res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
    }
});

// ─── Skills Reset API ────────────────────────────────
app.post('/api/skills/reset', async (req, res) => {
    try {
        const mode = (req.query.mode === 'hard') ? 'hard' as const : 'soft' as const;
        const ctx = makeWebCommandCtx(req);
        const result = await ctx.resetSkills(mode);
        res.json({ ok: true, ...result });
    } catch (e: unknown) {
        res.status(500).json({ error: (e as Error).message });
    }
});

// ─── Memory API (Phase A) ────────────────────────────

app.get('/api/jaw-memory/search', (req, res) => {
    try {
        const q = String(req.query.q || '');
        const mem = getMemoryStatus();
        res.json({ result: mem.routing.searchRead === 'advanced' ? searchIndexedMemory(q) : memory.search(q) });
    }
    catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
});

app.get('/api/jaw-memory/read', (req, res) => {
    try {
        const file = assertMemoryRelPath(String(req.query.file || ''), { allowExt: ['.md', '.txt', '.json'] });
        const mem = getMemoryStatus();
        const content = mem.routing.searchRead === 'advanced'
            ? readIndexedMemorySnippet(normalizeAdvancedReadPath(file), { lines: req.query.lines as any })
            : memory.read(file, { lines: req.query.lines as any });
        res.json({ content });
    } catch (e: unknown) { res.status((e as any).statusCode || 500).json({ error: (e as Error).message }); }
});

app.post('/api/jaw-memory/save', (req, res) => {
    try {
        const file = assertMemoryRelPath(String(req.body.file || ''), { allowExt: ['.md', '.txt', '.json'] });
        const p = memory.save(file, req.body.content);
        res.json({ ok: true, path: p });
    } catch (e: unknown) { res.status((e as any).statusCode || 500).json({ error: (e as Error).message }); }
});

app.get('/api/jaw-memory/list', (_, res) => {
    try { res.json({ files: memory.list() }); }
    catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
});

app.post('/api/jaw-memory/init', (_, res) => {
    try { memory.ensureMemoryDir(); res.json({ ok: true }); }
    catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
});

// ─── Browser API (Phase 7) — see src/routes/browser.js
registerBrowserRoutes(app);


// ─── i18n API ────────────────────────────────────────

app.get('/api/i18n/languages', (_, res) => {
    const localeDir = join(projectRoot, 'public', 'locales');
    if (!fs.existsSync(localeDir)) return res.json({ languages: ['ko'], default: 'ko' });
    const langs = fs.readdirSync(localeDir)
        .filter(f => f.endsWith('.json') && !f.startsWith('skills-'))
        .map(f => f.replace('.json', ''));
    res.json({ languages: langs, default: normalizeLocale(settings.locale, 'ko') });
});

app.get('/api/i18n/:lang', (req, res) => {
    const raw = req.params.lang.replace(/[^a-z-]/gi, '');
    const lang = normalizeLocale(raw, '');
    if (!lang) return res.status(404).json({ error: 'locale not found' });
    const filePath = join(projectRoot, 'public', 'locales', `${lang}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'locale not found' });
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
});

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

    setTimeout(() => {
        console.warn('[server] force exit (timeout)');
        process.exit(1);
    }, 3000).unref();
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
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
    log.info(`  DB:     ${DB_PATH}`);
    log.info(`  Prompts: ${PROMPTS_DIR}\n`);

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
    initActiveMessagingRuntime().catch((e: unknown) => {
        console.error('[messaging:boot]', (e as Error).message);
    });
    startHeartbeat();

    // ─── Seed default employees if none exist ────────
    const seeded = seedDefaultEmployees();
    if (seeded.seeded > 0) {
        console.log(`  Agents: seeded ${seeded.seeded} default employees (CLI: ${seeded.cli})`);
    }

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
