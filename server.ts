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
import { InputFile } from 'grammy';
import { readClaudeCreds, readCodexTokens, fetchClaudeUsage, fetchCodexUsage, readGeminiAccount } from './src/routes/quota.js';
import { registerBrowserRoutes } from './src/routes/browser.js';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll,
    ensureSkillsSymlinks, initMcpConfig, copyDefaultSkills,
} from './lib/mcp-sync.js';

// ─── src/ modules ────────────────────────────────────

import { assertSkillId, assertFilename, safeResolveUnder } from './src/security/path-guards.js';
import { decodeFilenameSafe } from './src/security/decode.js';
import { ok, fail } from './src/http/response.js';
import { mergeSettingsPatch } from './src/core/settings-merge.js';
import { setWss, broadcast } from './src/core/bus.js';
import * as browser from './src/browser/index.js';
import * as memory from './src/memory/memory.js';
import { loadLocales, t, normalizeLocale } from './src/core/i18n.js';
import {
    JAW_HOME, PROMPTS_DIR, DB_PATH, UPLOADS_DIR,
    SKILLS_DIR, SKILLS_REF_DIR,
    settings, loadSettings, saveSettings, replaceSettings,
    ensureDirs, runMigration,
    loadHeartbeatFile, saveHeartbeatFile,
    detectAllCli, APP_VERSION,
} from './src/core/config.js';
import {
    db, getSession, updateSession, insertMessage, getMessages, getMessagesWithTrace,
    getRecentMessages, clearMessages,
    getMemory, upsertMemory, deleteMemory,
    getEmployees, insertEmployee, deleteEmployee,
} from './src/core/db.js';
import {
    initPromptFiles, getMemoryDir, getSystemPrompt, regenerateB,
    A2_PATH, HEARTBEAT_PATH,
    getMergedSkills,
} from './src/prompt/builder.js';
import {
    activeProcess, killActiveAgent, killAllAgents, waitForProcessEnd,
    steerAgent, enqueueMessage, processQueue, messageQueue,
    saveUpload, memoryFlushCounter, resetFallbackState,
} from './src/agent/spawn.js';
import { parseCommand, executeCommand, COMMANDS } from './src/cli/commands.js';
import { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } from './src/orchestrator/pipeline.js';
import { submitMessage } from './src/orchestrator/gateway.js';
import { makeCommandCtx } from './src/cli/command-context.js';
import { initTelegram, telegramBot, telegramActiveChatIds } from './src/telegram/bot.js';
import { startHeartbeat, stopHeartbeat, watchHeartbeatFile } from './src/memory/heartbeat.js';
import { fetchCopilotQuota } from './lib/quota-copilot.js';
import { CLI_REGISTRY } from './src/cli/registry.js';

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

const PORT = process.env.PORT || 3457;
const DEFAULT_EMPLOYEES = [
    { name: 'Frontend', role: 'UI/UX, CSS, components' },
    { name: 'Backend', role: 'API, DB, server logic' },
    { name: 'Data', role: 'Data pipeline, analysis, ML' },
    { name: 'Docs', role: 'Documentation, README, API docs' },
];

ensureDirs();
fs.mkdirSync(join(projectRoot, 'public'), { recursive: true });
runMigration(projectRoot);
loadSettings();

// Phase 3.1: safe → auto 강제 마이그레이션 (기존 사용자 대응)
if (settings.permissions === 'safe') {
    settings.permissions = 'auto';
    saveSettings(settings);
    console.log('[jaw:migrate] permissions: safe → auto');
}

initPromptFiles();
regenerateB();


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
    'http://localhost:3457',
    'http://127.0.0.1:3457',
    `http://localhost:${process.env.PORT || 3457}`,
    `http://127.0.0.1:${process.env.PORT || 3457}`,
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
app.use(express.static(join(projectRoot, 'public')));

// WebSocket incoming messages
wss.on('connection', (ws) => {
    if (activeProcess) {
        ws.send(JSON.stringify({ type: 'agent_status', status: 'running', agentId: 'active' }));
    }
    if (messageQueue.length > 0) {
        ws.send(JSON.stringify({ type: 'queue_update', pending: messageQueue.length }));
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
        activeAgent: !!activeProcess,
        queuePending: messageQueue.length,
    };
}

function clearSessionState() {
    clearMessages.run();
    const session = getSession() as Record<string, any>;
    updateSession.run(session.active_cli, null, session.model, session.permissions, session.working_dir, session.effort);
    broadcast('clear', {});
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

function applySettingsPatch(rawPatch: Record<string, any> = {}, { restartTelegram = false } = {}) {
    const prevCli = settings.cli;
    const prevWorkingDir = settings.workingDir;
    const hasTelegramUpdate = !!(rawPatch || {}).telegram || (rawPatch || {}).locale !== undefined;

    const merged = mergeSettingsPatch(settings, rawPatch);
    replaceSettings(merged);
    saveSettings(settings);
    resetFallbackState();
    const session = getSession() as Record<string, any>;
    const ao = settings.activeOverrides?.[settings.cli] || {};
    const pc = settings.perCli?.[settings.cli] || {};
    const activeModel = ao.model || pc.model || 'default';
    const activeEffort = ao.effort || pc.effort || 'medium';
    const sessionId = (settings.cli !== prevCli) ? null : session.session_id;
    if (settings.cli !== prevCli && session.session_id) {
        console.log(`[jaw:session] invalidated — CLI changed ${prevCli} → ${settings.cli}`);
    }
    updateSession.run(settings.cli, sessionId, activeModel, settings.permissions, settings.workingDir, activeEffort);

    // workingDir 변경 시 산출물 재생성
    if (settings.workingDir !== prevWorkingDir) {
        try {
            initMcpConfig(settings.workingDir);
            ensureSkillsSymlinks(settings.workingDir, { onConflict: 'backup' });
            syncToAll(loadUnifiedMcp());
            regenerateB();
            console.log(`[jaw:workingDir] artifacts regenerated for ${settings.workingDir}`);
        } catch (e: unknown) { console.error('[jaw:workingDir]', (e as Error).message); }
    }

    if (restartTelegram && hasTelegramUpdate) initTelegram();
    return settings;
}

function seedDefaultEmployees({ reset = false, notify = false } = {}) {
    const existing = getEmployees.all();
    if (reset) {
        for (const emp of existing) deleteEmployee.run((emp as any).id);
    } else if (existing.length > 0) {
        return { seeded: 0, cli: settings.cli, skipped: true };
    }

    const cli = settings.cli;
    for (const emp of DEFAULT_EMPLOYEES) {
        insertEmployee.run(crypto.randomUUID(), emp.name, cli, 'default', emp.role);
    }
    if (notify) broadcast('agent_updated', {});
    regenerateB();
    return { seeded: DEFAULT_EMPLOYEES.length, cli, skipped: false };
}

function makeWebCommandCtx(req: any, localeOverride: string | null = null) {
    return makeCommandCtx('web', resolveRequestLocale(req, localeOverride), {
        applySettings: (patch) => applySettingsPatch(patch, { restartTelegram: true }),
        clearSession: () => clearSessionState(),
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
    if (activeProcess) {
        return res.status(409).json({ error: 'agent already running' });
    }
    orchestrateContinue({ origin: 'web' });
    res.json({ ok: true });
});

app.post('/api/orchestrate/reset', (req, res) => {
    if (activeProcess) {
        return res.status(409).json({ error: 'agent already running' });
    }
    orchestrateReset({ origin: 'web' });
    res.json({ ok: true });
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
app.get('/api/settings', (_, res) => ok(res, settings, settings));
app.put('/api/settings', (req, res) => {
    ok(res, applySettingsPatch(req.body, { restartTelegram: true }));
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
    ok(res, null);
});
app.delete('/api/memory/:key', (req, res) => {
    deleteMemory.run(req.params.key);
    ok(res, null);
});

// Memory files (Claude native)
app.get('/api/memory-files', (_, res) => {
    const memDir = getMemoryDir();
    let files: any[] = [];
    if (fs.existsSync(memDir)) {
        files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse().map(f => {
            const content = fs.readFileSync(join(memDir, f), 'utf8');
            const entries = content.split(/^## /m).filter(Boolean).length;
            return { name: f, entries, size: content.length };
        });
    }
    res.json({
        enabled: settings.memory?.enabled !== false,
        flushEvery: settings.memory?.flushEvery ?? 20,
        cli: settings.memory?.cli || '',
        model: settings.memory?.model || '',
        retentionDays: settings.memory?.retentionDays ?? 30,
        path: memDir, files,
        counter: memoryFlushCounter,
    });
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
    settings.memory = { ...settings.memory, ...req.body };
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

        const caption = req.body?.caption ? String(req.body.caption) : undefined;
        const file = new InputFile(filePath);

        switch (type) {
            case 'voice':
                await telegramBot.api.sendVoice(chatId, file, { caption });
                break;
            case 'photo':
                await telegramBot.api.sendPhoto(chatId, file, { caption });
                break;
            case 'document':
                await telegramBot.api.sendDocument(chatId, file, { caption });
                break;
            default:
                return res.status(400).json({ error: `unsupported type: ${type}` });
        }

        return res.json({ ok: true, chat_id: chatId, type });
    } catch (e: unknown) {
        console.error('[telegram:send]', e);
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
    const [claude, codex, copilot] = await Promise.all([
        fetchClaudeUsage(readClaudeCreds()),
        fetchCodexUsage(readCodexTokens()),
        fetchCopilotQuota(),
    ]);
    const gemini = readGeminiAccount();
    res.json({ claude, codex, gemini, opencode: null, copilot });
});

// Employees
app.get('/api/employees', (_, res) => ok(res, getEmployees.all()));
app.post('/api/employees', (req, res) => {
    const id = crypto.randomUUID();
    const { name = 'New Agent', cli = 'claude', model = 'default', role = '' } = req.body || {};
    insertEmployee.run(id, name, cli, model, role);
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
    saveHeartbeatFile(data);
    startHeartbeat();
    res.json(data);
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
app.post('/api/skills/reset', (req, res) => {
    try {
        // Clear before recopy (parity with CLI skill reset)
        if (fs.existsSync(SKILLS_DIR)) fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
        if (fs.existsSync(SKILLS_REF_DIR)) fs.rmSync(SKILLS_REF_DIR, { recursive: true, force: true });
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
        fs.mkdirSync(SKILLS_REF_DIR, { recursive: true });
        copyDefaultSkills();
        const symlinks = ensureSkillsSymlinks(settings.workingDir, { onConflict: 'backup' });
        regenerateB();
        res.json({ ok: true, symlinks });
    } catch (e: unknown) {
        res.status(500).json({ error: (e as Error).message });
    }
});

// ─── Memory API (Phase A) ────────────────────────────

app.get('/api/jaw-memory/search', (req, res) => {
    try { res.json({ result: memory.search(String(req.query.q || '')) }); }
    catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
});

app.get('/api/jaw-memory/read', (req, res) => {
    try {
        const file = assertFilename(req.query.file as string, { allowExt: ['.md', '.txt', '.json'] });
        const content = memory.read(file, { lines: req.query.lines as any });
        res.json({ content });
    } catch (e: unknown) { res.status((e as any).statusCode || 500).json({ error: (e as Error).message }); }
});

app.post('/api/jaw-memory/save', (req, res) => {
    try {
        const file = assertFilename(req.body.file, { allowExt: ['.md', '.txt', '.json'] });
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

// ─── Start ───────────────────────────────────────────

watchHeartbeatFile();

// ─── Graceful Shutdown ──────────────────────────────
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
    console.log(`\n[server] ${sig} received, shutting down...`);
    stopHeartbeat();
    killAllAgents('shutdown');
    wss.close();
    server.close(() => {
        console.log('[server] closed');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
}));

server.listen(PORT, () => {
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
        const symlinks = ensureSkillsSymlinks(settings.workingDir, { onConflict: 'backup' });
        copyDefaultSkills();
        const moved = (symlinks?.links || []).filter(x => x.action === 'backup_replace');
        if (moved.length) {
            console.log(`  Skills: moved ${moved.length} conflict path(s) to ~/.cli-jaw/backups/skills-conflicts`);
        }
        console.log(`  MCP:    ~/.cli-jaw/mcp.json`);
    } catch (e: unknown) { console.error('[mcp-init]', (e as Error).message); }

    initTelegram();
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
});
