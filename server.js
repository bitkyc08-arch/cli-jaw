// ─── CLI-Claw Server (glue + routes) ─────────────────
// All business logic lives in src/ modules.

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { InputFile } from 'grammy';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll,
    ensureSkillsSymlinks, initMcpConfig, copyDefaultSkills,
} from './lib/mcp-sync.js';

// ─── src/ modules ────────────────────────────────────

import { setWss, broadcast } from './src/bus.js';
import * as browser from './src/browser/index.js';
import * as memory from './src/memory.js';
import { loadLocales, t, normalizeLocale } from './src/i18n.js';
import {
    CLAW_HOME, PROMPTS_DIR, DB_PATH, UPLOADS_DIR,
    SKILLS_DIR, SKILLS_REF_DIR,
    settings, loadSettings, saveSettings, replaceSettings,
    ensureDirs, runMigration,
    loadHeartbeatFile, saveHeartbeatFile,
    detectAllCli, APP_VERSION,
} from './src/config.js';
import {
    db, getSession, updateSession, insertMessage, getMessages, getMessagesWithTrace,
    getRecentMessages, clearMessages,
    getMemory, upsertMemory, deleteMemory,
    getEmployees, insertEmployee, deleteEmployee,
} from './src/db.js';
import {
    initPromptFiles, getMemoryDir, getSystemPrompt, regenerateB,
    A2_PATH, HEARTBEAT_PATH,
    getMergedSkills,
} from './src/prompt.js';
import {
    activeProcess, killActiveAgent, waitForProcessEnd,
    steerAgent, enqueueMessage, processQueue, messageQueue,
    saveUpload, memoryFlushCounter,
} from './src/agent.js';
import { parseCommand, executeCommand, COMMANDS } from './src/commands.js';
import { orchestrate, orchestrateContinue, isContinueIntent } from './src/orchestrator.js';
import { initTelegram, telegramBot, telegramActiveChatIds } from './src/telegram.js';
import { startHeartbeat, stopHeartbeat, watchHeartbeatFile } from './src/heartbeat.js';
import { fetchCopilotQuota } from './lib/quota-copilot.js';
import { CLI_REGISTRY } from './src/cli-registry.js';

// ─── Resolve paths ───────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── .env loader (no dependency) ─────────────────────

try {
    const envPath = join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^([A-Z_]+)=(.*)$/);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
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
fs.mkdirSync(join(__dirname, 'public'), { recursive: true });
runMigration(__dirname);
loadSettings();
initPromptFiles();
regenerateB();

// ─── Quota (stays here — only used by one route) ─────

import { execSync } from 'child_process';

function readClaudeCreds() {
    try {
        const raw = execSync(
            'security find-generic-password -s "Claude Code-credentials" -w',
            { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toString().trim();
        const oauth = JSON.parse(raw)?.claudeAiOauth;
        if (!oauth?.accessToken) return null;
        return {
            token: oauth.accessToken,
            account: { type: oauth.subscriptionType ?? 'unknown', tier: oauth.rateLimitTier ?? null },
        };
    } catch { return null; }
}

function readCodexTokens() {
    try {
        const authPath = join(os.homedir(), '.codex', 'auth.json');
        const j = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        if (j?.tokens?.access_token) return { access_token: j.tokens.access_token, account_id: j.tokens.account_id ?? '' };
    } catch { }
    return null;
}

async function fetchClaudeUsage(creds) {
    if (!creds?.token) return null;
    try {
        const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: { 'Authorization': `Bearer ${creds.token}`, 'anthropic-beta': 'oauth-2025-04-20' },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const windows = [];
        const labelMap = { five_hour: '5-hour', seven_day: '7-day', seven_day_sonnet: '7-day Sonnet', seven_day_opus: '7-day Opus' };
        for (const [key, label] of Object.entries(labelMap)) {
            if (data[key]?.utilization != null) {
                windows.push({ label, percent: Math.round(data[key].utilization), resetsAt: data[key].resets_at ?? null });
            }
        }
        return { account: creds.account, windows, raw: data };
    } catch { return null; }
}

async function fetchCodexUsage(tokens) {
    if (!tokens) return null;
    try {
        const resp = await fetch('https://chatgpt.com/backend-api/wham/usage', {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': tokens.account_id ?? '' },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const account = { email: data.email ?? null, plan: data.plan_type ?? null };
        const windows = [];
        if (data.rate_limit?.primary_window) {
            windows.push({ label: '5-hour', percent: data.rate_limit.primary_window.used_percent ?? 0, resetsAt: data.rate_limit.primary_window.reset_at ? new Date(data.rate_limit.primary_window.reset_at * 1000).toISOString() : null });
        }
        if (data.rate_limit?.secondary_window) {
            windows.push({ label: '7-day', percent: data.rate_limit.secondary_window.used_percent ?? 0, resetsAt: data.rate_limit.secondary_window.reset_at ? new Date(data.rate_limit.secondary_window.reset_at * 1000).toISOString() : null });
        }
        return { account, windows, raw: data };
    } catch { return null; }
}

function readGeminiAccount() {
    try {
        const credsPath = join(os.homedir(), '.gemini', 'oauth_creds.json');
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        if (creds?.id_token) {
            const payload = JSON.parse(Buffer.from(creds.id_token.split('.')[1], 'base64url').toString());
            return { account: { email: payload.email ?? null }, windows: [] };
        }
    } catch { }
    return null;
}

// ─── Express + WebSocket ─────────────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

setWss(wss);
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

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

                // Continue intent는 큐에 넣지 않고 명시적으로 처리
                if (isContinueIntent(text)) {
                    if (activeProcess) {
                        broadcast('agent_done', {
                            text: t('ws.agentBusy', {}, resolveRequestLocale(null, settings.locale)),
                            error: true,
                        });
                    } else {
                        insertMessage.run('user', text, 'cli', '');
                        broadcast('new_message', { role: 'user', content: text, source: 'cli' });
                        orchestrateContinue({ origin: 'cli' });
                    }
                    return;
                }

                if (activeProcess) {
                    enqueueMessage(text, 'cli');
                } else {
                    insertMessage.run('user', text, 'cli', '');
                    broadcast('new_message', { role: 'user', content: text, source: 'cli' });
                    orchestrate(text, { origin: 'cli' });
                }
            }
            if (msg.type === 'stop') killActiveAgent('ws');
        } catch { }
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
    const session = getSession();
    updateSession.run(session.active_cli, null, session.model, session.permissions, session.working_dir, session.effort);
    broadcast('clear', {});
}

function resolveRequestLocale(req, preferred = null) {
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

function applySettingsPatch(rawPatch = {}, { restartTelegram = false } = {}) {
    const patch = { ...(rawPatch || {}) };
    const prevCli = settings.cli;
    const hasTelegramUpdate = !!patch.telegram || patch.locale !== undefined;

    // Deep merge perCli at per-CLI level (so individual model/effort fields aren't wiped)
    if (patch.perCli && typeof patch.perCli === 'object') {
        settings.perCli = settings.perCli || {};
        for (const [cli, cfg] of Object.entries(patch.perCli)) {
            settings.perCli[cli] = { ...settings.perCli[cli], ...cfg };
        }
        delete patch.perCli;
    }

    // Deep merge activeOverrides at per-CLI level
    if (patch.activeOverrides && typeof patch.activeOverrides === 'object') {
        settings.activeOverrides = settings.activeOverrides || {};
        for (const [cli, cfg] of Object.entries(patch.activeOverrides)) {
            settings.activeOverrides[cli] = { ...settings.activeOverrides[cli], ...cfg };
        }
        delete patch.activeOverrides;
    }

    for (const key of ['heartbeat', 'telegram', 'memory']) {
        if (patch[key] && typeof patch[key] === 'object') {
            settings[key] = { ...settings[key], ...patch[key] };
            delete patch[key];
        }
    }

    replaceSettings({ ...settings, ...patch });
    saveSettings(settings);

    const session = getSession();
    const ao = settings.activeOverrides?.[settings.cli] || {};
    const pc = settings.perCli?.[settings.cli] || {};
    const activeModel = ao.model || pc.model || 'default';
    const activeEffort = ao.effort || pc.effort || 'medium';
    const sessionId = (settings.cli !== prevCli) ? null : session.session_id;
    if (settings.cli !== prevCli && session.session_id) {
        console.log(`[claw:session] invalidated — CLI changed ${prevCli} → ${settings.cli}`);
    }
    updateSession.run(settings.cli, sessionId, activeModel, settings.permissions, settings.workingDir, activeEffort);

    if (restartTelegram && hasTelegramUpdate) initTelegram();
    return settings;
}

function seedDefaultEmployees({ reset = false, notify = false } = {}) {
    const existing = getEmployees.all();
    if (reset) {
        for (const emp of existing) deleteEmployee.run(emp.id);
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

function makeWebCommandCtx(req, localeOverride = null) {
    return {
        interface: 'web',
        locale: resolveRequestLocale(req, localeOverride),
        version: APP_VERSION,
        getSession,
        getSettings: () => settings,
        updateSettings: async (patch) => applySettingsPatch(patch, { restartTelegram: true }),
        getRuntime: getRuntimeSnapshot,
        getSkills: getMergedSkills,
        clearSession: async () => clearSessionState(),
        getCliStatus: () => detectAllCli(),
        getMcp: () => loadUnifiedMcp(),
        syncMcp: async () => ({ results: syncToAll(loadUnifiedMcp(), settings.workingDir) }),
        installMcp: async () => {
            const config = loadUnifiedMcp();
            const { installMcpServers } = await import('./lib/mcp-sync.js');
            const results = await installMcpServers(config);
            saveUnifiedMcp(config);
            const synced = syncToAll(config, settings.workingDir);
            return { results, synced };
        },
        listMemory: () => memory.list(),
        searchMemory: (q) => memory.search(q),
        getBrowserStatus: async () => browser.getBrowserStatus(settings.browser?.cdpPort || 9240),
        getBrowserTabs: async () => ({ tabs: await browser.listTabs(settings.browser?.cdpPort || 9240) }),
        resetEmployees: async () => seedDefaultEmployees({ reset: true, notify: true }),
        resetSkills: async () => {
            copyDefaultSkills();
            const symlinks = ensureSkillsSymlinks(settings.workingDir, { onConflict: 'backup' });
            regenerateB();
            return { symlinks };
        },
        getPrompt: () => {
            const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
            return { content: a2 };
        },
    };
}

app.get('/api/session', (_, res) => res.json(getSession()));
app.get('/api/messages', (req, res) => {
    const includeTrace = ['1', 'true', 'yes'].includes(String(req.query.includeTrace || '').toLowerCase());
    const rows = includeTrace ? getMessagesWithTrace.all() : getMessages.all();
    res.json(rows);
});
app.get('/api/runtime', (_, res) => res.json(getRuntimeSnapshot()));

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
        const result = await executeCommand(parsed, makeWebCommandCtx(req, locale));
        res.json(result);
    } catch (err) {
        console.error('[cmd:error]', err);
        const locale = resolveRequestLocale(req, req.body?.locale);
        res.status(500).json({
            ok: false,
            code: 'internal_error',
            text: t('api.serverError', { msg: err.message }, locale),
        });
    }
});

app.get('/api/commands', (req, res) => {
    const iface = String(req.query.interface || 'web');
    const locale = resolveRequestLocale(req, req.query.locale);
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
    const trimmed = prompt.trim();

    // Continue intent는 큐에 넣지 않고 전용 경로로 처리
    if (isContinueIntent(trimmed)) {
        if (activeProcess) {
            return res.status(409).json({ error: 'agent already running' });
        }
        orchestrateContinue({ origin: 'web' });
        return res.json({ ok: true, continued: true });
    }

    if (activeProcess) {
        enqueueMessage(trimmed, 'web');
        return res.json({ ok: true, queued: true, pending: messageQueue.length });
    }
    orchestrate(trimmed, { origin: 'web' });
    res.json({ ok: true });
});

app.post('/api/orchestrate/continue', (req, res) => {
    if (activeProcess) {
        return res.status(409).json({ error: 'agent already running' });
    }
    orchestrateContinue({ origin: 'web' });
    res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
    const killed = killActiveAgent('api');
    res.json({ ok: true, killed });
});

app.post('/api/clear', (_, res) => {
    clearSessionState();
    res.json({ ok: true });
});

// Settings
app.get('/api/settings', (_, res) => res.json(settings));
app.put('/api/settings', (req, res) => {
    res.json(applySettingsPatch(req.body, { restartTelegram: true }));
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
app.get('/api/memory', (_, res) => res.json(getMemory.all()));
app.post('/api/memory', (req, res) => {
    const { key, value, source = 'manual' } = req.body;
    if (!key || !value) return res.status(400).json({ error: 'key and value required' });
    upsertMemory.run(key, value, source);
    res.json({ ok: true });
});
app.delete('/api/memory/:key', (req, res) => {
    deleteMemory.run(req.params.key);
    res.json({ ok: true });
});

// Memory files (Claude native)
app.get('/api/memory-files', (_, res) => {
    const memDir = getMemoryDir();
    let files = [];
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
    const fp = join(getMemoryDir(), req.params.filename);
    if (!fp.endsWith('.md') || !fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
    res.json({ name: req.params.filename, content: fs.readFileSync(fp, 'utf8') });
});
app.delete('/api/memory-files/:filename', (req, res) => {
    const fp = join(getMemoryDir(), req.params.filename);
    if (fp.endsWith('.md') && fs.existsSync(fp)) fs.unlinkSync(fp);
    res.json({ ok: true });
});
app.put('/api/memory-files/settings', (req, res) => {
    settings.memory = { ...settings.memory, ...req.body };
    saveSettings(settings);
    res.json({ ok: true });
});

// File upload
app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    const rawHeader = req.headers['x-filename'] || 'upload.bin';
    const filename = decodeURIComponent(rawHeader);
    const filePath = saveUpload(req.body, filename);
    res.json({ path: filePath, filename: basename(filePath) });
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
    } catch (e) {
        console.error('[telegram:send]', e);
        return res.status(500).json({ error: e.message });
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
    const results = syncToAll(config, settings.workingDir);
    res.json({ ok: true, results });
});
app.post('/api/mcp/install', async (req, res) => {
    try {
        const config = loadUnifiedMcp();
        const { installMcpServers } = await import('./lib/mcp-sync.js');
        const results = await installMcpServers(config);
        saveUnifiedMcp(config);
        const syncResults = syncToAll(config, settings.workingDir);
        res.json({ ok: true, results, synced: syncResults });
    } catch (e) {
        console.error('[mcp:install]', e);
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/mcp/reset', (req, res) => {
    try {
        const mcpPath = join(CLAW_HOME, 'mcp.json');
        if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);
        const config = initMcpConfig(settings.workingDir);
        const results = syncToAll(config, settings.workingDir);
        res.json({
            ok: true,
            servers: Object.keys(config.servers),
            count: Object.keys(config.servers).length,
            synced: results,
        });
    } catch (e) {
        console.error('[mcp:reset]', e);
        res.status(500).json({ error: e.message });
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
app.get('/api/employees', (_, res) => res.json(getEmployees.all()));
app.post('/api/employees', (req, res) => {
    const id = crypto.randomUUID();
    const { name = 'New Agent', cli = 'claude', model = 'default', role = '' } = req.body || {};
    insertEmployee.run(id, name, cli, model, role);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    broadcast('agent_added', emp);
    regenerateB();
    res.json(emp);
});
app.put('/api/employees/:id', (req, res) => {
    const updates = req.body;
    const allowed = ['name', 'cli', 'model', 'role', 'status'];
    const sets = Object.keys(updates).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (sets.length === 0) return res.status(400).json({ error: 'no valid fields' });
    const vals = sets.map((_, i) => updates[Object.keys(updates).filter(k => allowed.includes(k))[i]]);
    db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
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
    const lang = (req.query.locale || 'ko').toLowerCase();
    const skills = getMergedSkills().map(s => ({
        ...s,
        name: s[`name_${lang}`] || s.name,
        description: s[`desc_${lang}`] || s.description,
    }));
    res.json(skills);
});

app.post('/api/skills/enable', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');
    const dstDir = join(SKILLS_DIR, id);
    const dstPath = join(dstDir, 'SKILL.md');
    if (fs.existsSync(dstPath)) return res.json({ ok: true, msg: 'already enabled' });
    if (!fs.existsSync(refPath)) return res.status(404).json({ error: 'skill not found in ref' });
    fs.mkdirSync(dstDir, { recursive: true });
    // Copy all files from ref skill dir
    const refDir = join(SKILLS_REF_DIR, id);
    for (const f of fs.readdirSync(refDir)) {
        fs.copyFileSync(join(refDir, f), join(dstDir, f));
    }
    regenerateB();
    res.json({ ok: true });
});

app.post('/api/skills/disable', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const dstDir = join(SKILLS_DIR, id);
    if (!fs.existsSync(dstDir)) return res.json({ ok: true, msg: 'already disabled' });
    fs.rmSync(dstDir, { recursive: true });
    regenerateB();
    res.json({ ok: true });
});

app.get('/api/skills/:id', (req, res) => {
    const { id } = req.params;
    // Try active first, then ref
    const activePath = join(SKILLS_DIR, id, 'SKILL.md');
    const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');
    const path = fs.existsSync(activePath) ? activePath : refPath;
    if (!fs.existsSync(path)) return res.status(404).json({ error: 'not found' });
    res.type('text/markdown').send(fs.readFileSync(path, 'utf8'));
});

// ─── Skills Reset API ────────────────────────────────
app.post('/api/skills/reset', (req, res) => {
    try {
        copyDefaultSkills();
        const symlinks = ensureSkillsSymlinks(settings.workingDir, { onConflict: 'backup' });
        regenerateB();
        res.json({ ok: true, symlinks });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Memory API (Phase A) ────────────────────────────

app.get('/api/claw-memory/search', (req, res) => {
    try { res.json({ result: memory.search(req.query.q || '') }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/claw-memory/read', (req, res) => {
    try {
        const content = memory.read(req.query.file, { lines: req.query.lines });
        res.json({ content });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claw-memory/save', (req, res) => {
    try {
        const path = memory.save(req.body.file, req.body.content);
        res.json({ ok: true, path });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/claw-memory/list', (_, res) => {
    try { res.json({ files: memory.list() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claw-memory/init', (_, res) => {
    try { memory.ensureMemoryDir(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Browser API (Phase 7) ───────────────────────────

const cdpPort = () => settings.browser?.cdpPort || 9240;

app.post('/api/browser/start', async (req, res) => {
    try {
        await browser.launchChrome(req.body?.port || cdpPort());
        res.json(await browser.getBrowserStatus(cdpPort()));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/stop', async (_, res) => {
    try { await browser.closeBrowser(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browser/status', async (_, res) => {
    try { res.json(await browser.getBrowserStatus(cdpPort())); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browser/snapshot', async (req, res) => {
    try {
        res.json({
            nodes: await browser.snapshot(cdpPort(), {
                interactive: req.query.interactive === 'true',
            })
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/screenshot', async (req, res) => {
    try { res.json(await browser.screenshot(cdpPort(), req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/act', async (req, res) => {
    try {
        const { kind, ref, text, key, submit, doubleClick, x, y } = req.body;
        let result;
        switch (kind) {
            case 'click': result = await browser.click(cdpPort(), ref, { doubleClick }); break;
            case 'mouse-click': result = await browser.mouseClick(cdpPort(), x, y, { doubleClick }); break;
            case 'type': result = await browser.type(cdpPort(), ref, text, { submit }); break;
            case 'press': result = await browser.press(cdpPort(), key); break;
            case 'hover': result = await browser.hover(cdpPort(), ref); break;
            default: return res.status(400).json({ error: `unknown action: ${kind}` });
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Vision Click (Phase 2) ──────────────────────────
app.post('/api/browser/vision-click', async (req, res) => {
    try {
        const { target, provider, doubleClick } = req.body;
        if (!target) return res.status(400).json({ error: 'target required' });
        const result = await browser.visionClick(cdpPort(), target, { provider, doubleClick });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/browser/navigate', async (req, res) => {
    try { res.json(await browser.navigate(cdpPort(), req.body.url)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browser/tabs', async (_, res) => {
    try { res.json({ tabs: await browser.listTabs(cdpPort()) }); }
    catch { res.json({ tabs: [] }); }
});

app.post('/api/browser/evaluate', async (req, res) => {
    try { res.json(await browser.evaluate(cdpPort(), req.body.expression)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browser/text', async (req, res) => {
    try { res.json(await browser.getPageText(cdpPort(), req.query.format)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── i18n API ────────────────────────────────────────

app.get('/api/i18n/languages', (_, res) => {
    const localeDir = join(__dirname, 'public', 'locales');
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
    const filePath = join(__dirname, 'public', 'locales', `${lang}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'locale not found' });
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
});

// ─── Start ───────────────────────────────────────────

watchHeartbeatFile();

server.listen(PORT, () => {
    // Bootstrap i18n locale dictionaries
    loadLocales(join(__dirname, 'public', 'locales'));
    console.log(`\n  🦞 Claw Agent — http://localhost:${PORT}\n`);
    console.log(`  CLI:    ${settings.cli}`);
    console.log(`  Perms:  ${settings.permissions}`);
    console.log(`  CWD:    ${settings.workingDir}`);
    console.log(`  DB:     ${DB_PATH}`);
    console.log(`  Prompts: ${PROMPTS_DIR}\n`);

    try {
        initMcpConfig(settings.workingDir);
        const symlinks = ensureSkillsSymlinks(settings.workingDir, { onConflict: 'backup' });
        copyDefaultSkills();
        const moved = (symlinks?.links || []).filter(x => x.action === 'backup_replace');
        if (moved.length) {
            console.log(`  Skills: moved ${moved.length} conflict path(s) to ~/.cli-claw/backups/skills-conflicts`);
        }
        console.log(`  MCP:    ~/.cli-claw/mcp.json`);
    } catch (e) { console.error('[mcp-init]', e.message); }

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
        const en = NAME_MAP[emp.name];
        if (en) { db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(en, emp.id); migrated++; }
    }
    if (migrated > 0) console.log(`  Agents: migrated ${migrated} Korean names → English`);
});
