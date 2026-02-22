import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import https from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Config ──────────────────────────────────────────

const PORT = process.env.PORT || 3457;
const CLAW_HOME = join(os.homedir(), '.cli-claw');
const PROMPTS_DIR = join(CLAW_HOME, 'prompts');
const DB_PATH = join(__dirname, 'claw.db');
const SETTINGS_PATH = join(__dirname, 'settings.json');
const HEARTBEAT_JOBS_PATH = join(CLAW_HOME, 'heartbeat.json');

// ─── Ensure directories ─────────────────────────────

fs.mkdirSync(PROMPTS_DIR, { recursive: true });
fs.mkdirSync(join(__dirname, 'public'), { recursive: true });

// ─── A-1 Core System Prompt (immutable) ──────────────

const A1_CONTENT = `# Claw Agent

You are Claw Agent, a system-level AI assistant.
Execute tasks on the user's computer via CLI tools.

## Rules
- Follow the user's instructions precisely
- Respond in the user's language
- Report results clearly with file paths and outputs
- Ask for clarification when ambiguous
- If nothing needs attention on heartbeat, reply HEARTBEAT_OK
`;

// Ensure A-1.md exists
const A1_PATH = join(PROMPTS_DIR, 'A-1.md');
if (!fs.existsSync(A1_PATH)) {
    fs.writeFileSync(A1_PATH, A1_CONTENT);
}

// ─── A-2 User Prompt (mutable, default) ──────────────

const A2_DEFAULT = `# User Configuration

## Identity
- Name: Claw
- Emoji: 🦞

## User
- Name: (your name)
- Language: English
- Timezone: UTC

## Vibe
- Friendly, warm
- Technically accurate

## Working Directory
- ~/
`;

const A2_PATH = join(PROMPTS_DIR, 'A-2.md');
if (!fs.existsSync(A2_PATH)) {
    fs.writeFileSync(A2_PATH, A2_DEFAULT);
}

// ─── HEARTBEAT.md (separate) ─────────────────────────

const HEARTBEAT_DEFAULT = `# Heartbeat checklist

<!-- Keep this empty to skip heartbeat API calls -->
<!-- Add tasks below when you want periodic checks -->
`;

const HEARTBEAT_PATH = join(PROMPTS_DIR, 'HEARTBEAT.md');
if (!fs.existsSync(HEARTBEAT_PATH)) {
    fs.writeFileSync(HEARTBEAT_PATH, HEARTBEAT_DEFAULT);
}

// ─── B.md (auto-generated: A-1 + A-2 + Employees) ───

function getSystemPrompt() {
    const a1 = fs.readFileSync(A1_PATH, 'utf8');
    const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
    let prompt = `${a1}\n\n${a2}`;

    // Phase 5.0: Employee orchestration injection
    try {
        const emps = getEmployees.all();
        if (emps.length > 0) {
            const list = emps.map(e =>
                `- "${e.name}" (CLI: ${e.cli}) — ${e.role || '범용 개발자'}`
            ).join('\n');
            const example = emps[0].name;
            prompt += '\n\n---\n';
            prompt += '\n## Orchestration System';
            prompt += '\nYou have external employees (separate CLI processes).';
            prompt += '\nThe middleware detects your JSON output and AUTOMATICALLY spawns employees.';
            prompt += `\n\n### Available Employees\n${list}`;
            prompt += '\n\n### Dispatch Format';
            prompt += '\nTo assign work, output EXACTLY this format (triple-backtick fenced JSON block):';
            prompt += `\n\n\`\`\`json\n{\n  "subtasks": [\n    {\n      "agent": "${example}",\n      "task": "구체적인 작업 지시",\n      "priority": 1\n    }\n  ]\n}\n\`\`\``;
            prompt += '\n\n### CRITICAL RULES';
            prompt += '\n1. JSON은 반드시 \`\`\`json ... \`\`\` 코드블럭으로 감싸야 함 (필수)';
            prompt += '\n2. 코드블럭 없는 raw JSON 출력 금지';
            prompt += '\n3. agent 이름은 위 목록과 정확히 일치해야 함';
            prompt += '\n4. 실행 가능한 요청이면 반드시 subtask JSON 출력';
            prompt += '\n5. "결과 보고"를 받으면 사용자에게 자연어로 요약';
            prompt += '\n6. 직접 답변할 수 있는 질문이면 JSON 없이 자연어로 응답';
        }
    } catch { /* DB not ready yet */ }

    return prompt;
}

function regenerateB() {
    fs.writeFileSync(join(PROMPTS_DIR, 'B.md'), getSystemPrompt());

    // Invalidate session — next spawn starts fresh with updated prompt
    try {
        const session = getSession();
        if (session.session_id) {
            updateSession.run(session.active_cli, null, session.model,
                session.permissions, session.working_dir, session.effort);
            console.log('[claw:session] invalidated — B.md changed');
        }
    } catch { /* DB not ready yet */ }
}
// NOTE: regenerateB() called after DB init (see below)

// ─── Settings ────────────────────────────────────────

const DEFAULT_SETTINGS = {
    cli: 'claude',
    permissions: 'auto',      // safe | auto
    workingDir: os.homedir(),
    perCli: {
        claude: { model: 'claude-sonnet-4-5-20250929', effort: 'medium' },
        codex: { model: 'gpt-5.3-codex', effort: 'medium' },
        gemini: { model: 'gemini-2.5-pro', effort: '' },
        opencode: { model: 'github-copilot/claude-sonnet-4.5', effort: '' },
    },
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
    employees: [],
};

function loadSettings() {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
    } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = loadSettings();

// ─── Database ────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS session (
        id          TEXT PRIMARY KEY DEFAULT 'default',
        active_cli  TEXT DEFAULT 'claude',
        session_id  TEXT,
        model       TEXT DEFAULT 'default',
        permissions TEXT DEFAULT 'auto',
        working_dir TEXT DEFAULT '~',
        effort      TEXT DEFAULT 'medium',
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO session (id) VALUES ('default');

    CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        cli         TEXT,
        model       TEXT,
        cost_usd    REAL,
        duration_ms INTEGER,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

    CREATE TABLE IF NOT EXISTS memory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        value       TEXT NOT NULL,
        source      TEXT DEFAULT 'manual',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS employees (
        id          TEXT PRIMARY KEY,
        name        TEXT DEFAULT 'New Agent',
        cli         TEXT DEFAULT 'claude',
        model       TEXT DEFAULT 'default',
        role        TEXT DEFAULT '',
        status      TEXT DEFAULT 'idle',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// ─── DB Helpers ──────────────────────────────────────

const getSession = () => db.prepare('SELECT * FROM session WHERE id = ?').get('default');
const updateSession = db.prepare(`
    UPDATE session SET active_cli=?, session_id=?, model=?, permissions=?, working_dir=?, effort=?, updated_at=CURRENT_TIMESTAMP
    WHERE id='default'
`);
const insertMessage = db.prepare('INSERT INTO messages (role, content, cli, model) VALUES (?, ?, ?, ?)');
const getMessages = db.prepare('SELECT * FROM messages ORDER BY id ASC');
const getRecentMessages = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?');
const clearMessages = db.prepare('DELETE FROM messages');
const getMemory = db.prepare('SELECT key, value, source FROM memory ORDER BY updated_at DESC');
const upsertMemory = db.prepare(`
    INSERT INTO memory (key, value, source) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=CURRENT_TIMESTAMP
`);
const deleteMemory = db.prepare('DELETE FROM memory WHERE key = ?');
const getEmployees = db.prepare('SELECT * FROM employees ORDER BY created_at ASC');
const insertEmployee = db.prepare('INSERT INTO employees (id, name, cli, model, role) VALUES (?, ?, ?, ?, ?)');
const deleteEmployee = db.prepare('DELETE FROM employees WHERE id = ?');

// Now that DB is ready, generate B.md with employees
regenerateB();

// ─── CLI Detection ───────────────────────────────────

function detectCli(name) {
    try {
        const p = execSync(`which ${name}`, { encoding: 'utf8', timeout: 3000 }).trim();
        return { available: true, path: p };
    } catch { return { available: false, path: null }; }
}

function detectAllCli() {
    return {
        claude: detectCli('claude'),
        codex: detectCli('codex'),
        gemini: detectCli('gemini'),
        opencode: detectCli('opencode'),
    };
}

// ─── Quota (ported from claw-lite) ───────────────────

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
            account: {
                type: oauth.subscriptionType ?? 'unknown',
                tier: oauth.rateLimitTier ?? null,
            },
        };
    } catch { return null; }
}

function readCodexTokens() {
    try {
        const authPath = join(os.homedir(), '.codex', 'auth.json');
        const j = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        if (j?.tokens?.access_token) {
            return { access_token: j.tokens.access_token, account_id: j.tokens.account_id ?? '' };
        }
    } catch { }
    return null;
}

async function fetchClaudeUsage(creds) {
    if (!creds?.token) return null;
    try {
        const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'anthropic-beta': 'oauth-2025-04-20',
            },
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
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`,
                'ChatGPT-Account-Id': tokens.account_id ?? '',
            },
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

// ─── Agent Spawn ─────────────────────────────────────

let activeProcess = null;

function makeCleanEnv() {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.GEMINI_SYSTEM_MD;  // Clean slate, set per-spawn
    return env;
}

function buildArgs(cli, model, effort, prompt, sysPrompt) {
    switch (cli) {
        case 'claude':
            return ['--print', '--verbose', '--output-format', 'stream-json',
                '--dangerously-skip-permissions',
                '--max-turns', '50',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(effort && effort !== 'medium' ? ['--effort', effort] : []),
                ...(sysPrompt ? ['--append-system-prompt', sysPrompt] : [])];
        case 'codex':
            return ['exec',
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
                '--full-auto', '--skip-git-repo-check', '--json'];
        case 'gemini': {
            return ['-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '-y', '-o', 'stream-json'];
        }
        case 'opencode':
            return ['run',
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['--variant', effort] : []),
                '--format', 'json',
                prompt || ''];
        default:
            return [];
    }
}

function buildResumeArgs(cli, model, effort, sessionId, prompt) {
    switch (cli) {
        case 'claude':
            return ['--print', '--verbose', '--output-format', 'stream-json',
                '--dangerously-skip-permissions',
                '--resume', sessionId,
                '--max-turns', '50',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(effort && effort !== 'medium' ? ['--effort', effort] : [])];
        case 'codex':
            return ['exec', 'resume',
                ...(model && model !== 'default' ? ['--model', model] : []),
                '--full-auto', '--skip-git-repo-check',
                sessionId, prompt || '', '--json'];
        case 'gemini':
            return ['--resume', sessionId,
                '-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '-y', '-o', 'stream-json'];
        case 'opencode':
            return ['run', '-s', sessionId,
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['--variant', effort] : []),
                '--format', 'json',
                prompt || ''];
        default:
            return [];
    }
}

function spawnAgent(prompt, opts = {}) {
    const { forceNew = false, agentId, sysPrompt: customSysPrompt } = opts;

    if (activeProcess && !forceNew) {
        console.log('[claw] Agent already running, skipping');
        return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
    }

    let resolve;
    const resultPromise = new Promise(r => { resolve = r; });

    const session = getSession();
    const cli = opts.cli || session.active_cli || settings.cli;
    const cfg = settings.perCli?.[cli] || {};
    const model = opts.model || cfg.model || 'default';
    const effort = opts.effort || cfg.effort || '';

    // Resolve system prompt — sub-agents get only their own role prompt
    const sysPrompt = customSysPrompt || getSystemPrompt();

    // Resume: only for main agent (not forceNew)
    const isResume = !forceNew && session.session_id && session.active_cli === cli;
    let args;
    if (isResume) {
        console.log(`[claw:resume] ${cli} session=${session.session_id.slice(0, 12)}...`);
        args = buildResumeArgs(cli, model, effort, session.session_id, prompt);
    } else {
        args = buildArgs(cli, model, effort, prompt, sysPrompt);
    }

    const agentLabel = agentId || 'main';
    console.log(`[claw:${agentLabel}] Spawning: ${cli} ${args.join(' ').slice(0, 120)}...`);

    const spawnEnv = makeCleanEnv();

    // Gemini: system prompt via GEMINI_SYSTEM_MD env var (file path)
    if (cli === 'gemini' && sysPrompt) {
        const tmpSysFile = join(os.tmpdir(), `claw-gemini-sys-${agentLabel}.md`);
        fs.writeFileSync(tmpSysFile, sysPrompt);
        spawnEnv.GEMINI_SYSTEM_MD = tmpSysFile;
    }

    const child = spawn(cli, args, {
        cwd: settings.workingDir,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!forceNew) activeProcess = child;

    // User message — only for main agent (not forceNew, not internal)
    if (!forceNew && !opts.internal) {
        insertMessage.run('user', prompt, cli, model);
    }

    // Stdin: system prompt + recent messages + user message
    // Skip for: gemini (stdin = visible user msg), codex resume (already has context), opencode (prompt in args)
    const skipStdin = cli === 'gemini' || cli === 'opencode' || (cli === 'codex' && isResume);
    if (!skipStdin) {
        const sysPrompt = customSysPrompt || getSystemPrompt();
        let stdinContent = `[Claw Platform Context]\n${sysPrompt}`;

        // Include recent message history for context (non-resume, non-forceNew)
        if (!isResume && !forceNew) {
            const recent = getRecentMessages.all(5).reverse();
            if (recent.length > 0) {
                const history = recent.map(m => `[${m.role}] ${m.content}`).join('\n\n');
                stdinContent += `\n\n[Recent History]\n${history}`;
            }
        }

        stdinContent += `\n\n[User Message]\n${prompt}`;
        child.stdin.write(stdinContent);
    }
    child.stdin.end();

    // Broadcast
    broadcast('agent_status', { status: 'running', cli, agentId: agentLabel });

    const ctx = { fullText: '', toolLog: [], sessionId: null, cost: null, turns: null, duration: null, tokens: null, stderrBuf: '' };
    let buffer = '';

    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line);
                console.log(`[claw:event:${agentLabel}] ${cli} type=${event.type}`);
                console.log(`[claw:raw:${agentLabel}] ${line.slice(0, 300)}`);
                if (!ctx.sessionId) ctx.sessionId = extractSessionId(cli, event);
                extractFromEvent(cli, event, ctx, agentLabel);
            } catch { /* non-JSON line */ }
        }
    });

    child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        console.error(`[claw:stderr:${agentLabel}] ${text}`);
        ctx.stderrBuf += text + '\n';
    });

    child.on('close', (code) => {
        if (!forceNew) activeProcess = null;

        // Save session for resume — only main agent
        if (!forceNew && ctx.sessionId && code === 0) {
            updateSession.run(cli, ctx.sessionId, model, settings.permissions, settings.workingDir, cfg.effort || 'medium');
            console.log(`[claw:session] saved ${cli} session=${ctx.sessionId.slice(0, 12)}...`);
        }

        if (ctx.fullText.trim()) {
            const costParts = [];
            if (ctx.cost != null) costParts.push(`$${Number(ctx.cost).toFixed(4)}`);
            if (ctx.turns) costParts.push(`${ctx.turns}턴`);
            if (ctx.duration) costParts.push(`${(ctx.duration / 1000).toFixed(1)}s`);
            const costLine = costParts.length ? `\n\n✅ ${costParts.join(' · ')}` : '';
            // Strip JSON subtask blocks from display/storage
            const stripped = stripSubtaskJSON(ctx.fullText);
            const displayText = stripped || ctx.fullText.trim();
            const finalContent = displayText + costLine;

            if (!forceNew && !opts.internal) {
                insertMessage.run('assistant', finalContent, cli, model);
                broadcast('agent_done', { text: finalContent, toolLog: ctx.toolLog });
            }
        } else if (!forceNew && code !== 0) {
            let errMsg = `CLI 실행 실패 (exit ${code})`;
            if (ctx.stderrBuf.includes('429') || ctx.stderrBuf.includes('RESOURCE_EXHAUSTED')) {
                errMsg = '⚡ API 용량 초과 (429) — 잠시 후 다시 시도해주세요';
            } else if (ctx.stderrBuf.includes('auth') || ctx.stderrBuf.includes('credentials')) {
                errMsg = '🔐 인증 오류 — CLI 로그인 상태를 확인해주세요';
            } else if (ctx.stderrBuf.trim()) {
                errMsg = ctx.stderrBuf.trim().slice(0, 200);
            }
            broadcast('agent_done', { text: `❌ ${errMsg}`, error: true });
        }

        broadcast('agent_status', { status: code === 0 ? 'done' : 'error', agentId: agentLabel });
        console.log(`[claw:${agentLabel}] exited code=${code}, text=${ctx.fullText.length} chars`);

        resolve({ text: ctx.fullText, code, sessionId: ctx.sessionId, cost: ctx.cost, tools: ctx.toolLog });
    });

    return { child, promise: resultPromise };
}

// ─── Event Extraction (ported from claw-lite) ────────

function extractSessionId(cli, event) {
    switch (cli) {
        case 'claude': return event.type === 'system' ? event.session_id : null;
        case 'codex': return event.type === 'thread.started' ? event.thread_id : null;
        case 'gemini': return event.type === 'init' ? event.session_id : null;
        case 'opencode': return event.sessionID || null;
        default: return null;
    }
}

function extractFromEvent(cli, event, ctx, agentLabel) {
    // Generic tool/reasoning label extraction + broadcast
    const toolLabel = extractToolLabel(cli, event);
    if (toolLabel) {
        ctx.toolLog.push(toolLabel);
        broadcast('agent_tool', { agentId: agentLabel, ...toolLabel });
    }

    switch (cli) {
        case 'claude':
            if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'text') {
                        ctx.fullText += block.text;
                    }
                    // tool_use already handled by extractToolLabel
                }
            } else if (event.type === 'result') {
                ctx.cost = event.total_cost_usd;
                ctx.turns = event.num_turns;
                ctx.duration = event.duration_ms;
                if (event.session_id) ctx.sessionId = event.session_id;
            }
            break;
        case 'codex':
            if (event.type === 'item.completed') {
                if (event.item?.type === 'agent_message') {
                    ctx.fullText += event.item.text || '';
                }
                // command_execution, web_search, reasoning handled by extractToolLabel
            } else if (event.type === 'turn.completed' && event.usage) {
                ctx.tokens = event.usage;
            }
            break;
        case 'gemini':
            if (event.type === 'message' && event.role === 'assistant') {
                ctx.fullText += event.content || '';
            } else if (event.type === 'result') {
                ctx.duration = event.stats?.duration_ms;
                ctx.turns = event.stats?.tool_calls;
            }
            // tool_use/tool_result handled by extractToolLabel
            break;
        case 'opencode':
            if (event.type === 'text' && event.part?.text) {
                ctx.fullText += event.part.text;
            } else if (event.type === 'step_finish' && event.part) {
                ctx.sessionId = event.sessionID;
                if (event.part.tokens) {
                    ctx.tokens = { input_tokens: event.part.tokens.input, output_tokens: event.part.tokens.output };
                }
                if (event.part.cost) ctx.cost = event.part.cost;
            }
            // tool_use handled by extractToolLabel
            break;
    }
}

function extractToolLabel(cli, event) {
    const item = event.item || event.part || event;
    const type = item?.type || event.type;

    // Codex events
    if (cli === 'codex' && event.type === 'item.completed' && item) {
        if (item.type === 'web_search') {
            const action = item.action?.type || '';
            if (action === 'search') return { icon: '🔍', label: (item.query || item.action?.query || 'search').slice(0, 60) };
            if (action === 'open_page') { try { return { icon: '🌐', label: new URL(item.action.url).hostname }; } catch { return { icon: '🌐', label: 'page' }; } }
            return { icon: '🔍', label: (item.query || 'web').slice(0, 60) };
        }
        if (item.type === 'reasoning') return { icon: '💭', label: (item.text || '').replace(/\*+/g, '').trim().slice(0, 60) };
        if (item.type === 'command_execution') return { icon: '⚡', label: (item.command || 'exec').slice(0, 40) };
    }

    // Claude events
    if (cli === 'claude' && event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
            if (block.type === 'tool_use') return { icon: '🔧', label: block.name };
            if (block.type === 'thinking') return { icon: '💭', label: (block.thinking || '').slice(0, 60) };
        }
    }

    // Gemini events
    if (cli === 'gemini') {
        if (event.type === 'tool_use') return { icon: '🔧', label: `${event.tool_name || 'tool'}${event.parameters?.command ? ': ' + event.parameters.command.slice(0, 40) : ''}` };
        if (event.type === 'tool_result') return { icon: event.status === 'success' ? '✅' : '❌', label: `${event.status || 'done'}` };
    }

    // OpenCode events
    if (cli === 'opencode') {
        if (event.type === 'tool_use' && event.part) return { icon: '🔧', label: event.part.tool || 'tool' };
    }

    return null;
}

// ─── Orchestration (Phase 5) ─────────────────────────

const MAX_ROUNDS = 3;

function parseSubtasks(text) {
    if (!text) return null;
    // Try fenced code block first
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]).subtasks || null; } catch { }
    }
    // Fallback: raw JSON object with "subtasks" key
    const raw = text.match(/(\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*\]\s*\})/);
    if (raw) {
        try { return JSON.parse(raw[1]).subtasks || null; } catch { }
    }
    return null;
}

function stripSubtaskJSON(text) {
    return text
        .replace(/```json\n[\s\S]*?\n```/g, '')  // fenced
        .replace(/\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '')  // raw
        .trim();
}

async function distributeAndWait(subtasks) {
    const emps = getEmployees.all();
    const results = [];

    const promises = subtasks.map(st => {
        const target = (st.agent || '').trim();
        const emp = emps.find(e =>
            e.name === target || e.name?.includes(target) || target.includes(e.name)
        );
        console.log(`[distribute] matching "${target}" → ${emp ? emp.name : 'NOT FOUND'}`);

        if (!emp) {
            results.push({ name: target, status: 'skipped', text: 'Agent not found' });
            return Promise.resolve();
        }

        const sysPrompt = `당신은 "${emp.name}" 입니다.
역할: ${emp.role || '범용 개발자'}

## 규칙
- 주어진 작업을 직접 실행하고 결과를 보고하세요
- JSON subtask 출력 금지 (당신은 실행자이지 기획자가 아닙니다)
- 작업 결과를 자연어로 간결하게 보고하세요
- 사용자 언어로 응답하세요`;
        broadcast('agent_status', { agentId: emp.id, agentName: emp.name, status: 'running', cli: emp.cli });

        const { promise } = spawnAgent(`## 작업 지시\n${st.task}`, {
            agentId: emp.id, cli: emp.cli, model: emp.model,
            forceNew: true, sysPrompt,
        });

        return promise.then(r => {
            results.push({ name: emp.name, id: emp.id, status: r.code === 0 ? 'done' : 'error', text: r.text || '' });
            broadcast('agent_status', { agentId: emp.id, agentName: emp.name, status: r.code === 0 ? 'done' : 'error' });
        });
    });

    await Promise.all(promises);
    return results;
}

async function orchestrate(prompt) {
    const employees = getEmployees.all();

    // No employees → simple single-agent mode
    if (employees.length === 0) {
        spawnAgent(prompt);
        return;
    }

    // Planning agent settings (5.12)
    const planCli = settings.planning?.cli || settings.cli;
    const planModel = settings.planning?.model || 'default';
    const planEffort = settings.planning?.effort || '';
    const planOpts = { agentId: 'planning', cli: planCli, model: planModel, effort: planEffort };

    // Round 1: Planning Agent
    broadcast('agent_status', { agentId: 'planning', agentName: '🎯 기획', status: 'running' });
    const { promise: p1 } = spawnAgent(prompt, planOpts);
    const r1 = await p1;

    let subtasks = parseSubtasks(r1.text);
    if (!subtasks?.length) return;  // Direct answer, no subtasks

    let round = 1;
    let lastResults = [];
    while (round <= MAX_ROUNDS) {
        console.log(`[orchestrate] round ${round}, ${subtasks.length} subtasks`);
        broadcast('round_start', { round, subtasks });

        // Distribute to sub-agents
        const results = await distributeAndWait(subtasks);
        lastResults = results;

        // Report results to Planning Agent via resume session (5.11: keeps context for follow-up)
        const report = results.map(r =>
            `- ${r.name}: ${r.status === 'done' ? '✅ 완료' : '❌ 실패'}\n  응답: ${r.text.slice(0, 300)}`
        ).join('\n');
        const reportPrompt = `## 결과 보고 (라운드 ${round})\n${report}\n\n## 평가 기준\n- sub-agent가 응답을 보고했으면 → 완료로 판정\n- 단순 질문/인사 작업은 응답 자체가 성공적 결과입니다\n- 코드 작업은 실행 결과가 있으면 완료\n\n## 판정\n- **완료**: 사용자에게 보여줄 자연어 요약을 작성하세요. JSON 출력 절대 금지.\n- **미완료**: 구체적 사유를 밝히고 JSON subtasks를 다시 출력하세요.`;

        broadcast('agent_status', { agentId: 'planning', agentName: '🎯 기획', status: 'evaluating' });
        const { promise: evalP } = spawnAgent(reportPrompt, { ...planOpts, internal: true });
        const evalR = await evalP;

        subtasks = parseSubtasks(evalR.text);
        if (!subtasks?.length) {
            // Final evaluation — save as assistant message and broadcast
            const stripped = stripSubtaskJSON(evalR.text);
            if (stripped) {
                insertMessage.run('assistant', stripped, 'orchestrator', '');
                broadcast('agent_done', { text: stripped });
            }
            broadcast('round_done', { round, action: 'complete' });
            broadcast('agent_status', { agentId: 'planning', status: 'idle' });
            break;
        }
        broadcast('round_done', { round, action: 'retry' });
        round++;
    }

    // Fallback: MAX_ROUNDS exceeded — show last results
    if (round > MAX_ROUNDS) {
        const fallback = '⚠️ 최대 라운드(' + MAX_ROUNDS + ')에 도달했습니다.\n\n' +
            lastResults.map(r => `**${r.name}**: ${r.text.slice(0, 300)}`).join('\n\n');
        insertMessage.run('assistant', fallback, 'orchestrator', '');
        broadcast('agent_done', { text: fallback });
        broadcast('agent_status', { agentId: 'planning', status: 'idle' });
    }
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// WebSocket + internal broadcast
const broadcastListeners = new Set();
function addBroadcastListener(fn) { broadcastListeners.add(fn); }
function removeBroadcastListener(fn) { broadcastListeners.delete(fn); }

function broadcast(type, data) {
    const msg = JSON.stringify({ type, ...data, ts: Date.now() });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    for (const fn of broadcastListeners) fn(type, data);
}

// ─── API Routes ──────────────────────────────────────

// Session
app.get('/api/session', (_, res) => res.json(getSession()));

// Messages
app.get('/api/messages', (_, res) => res.json(getMessages.all()));

// Send message
app.post('/api/message', (req, res) => {
    const { prompt } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'prompt required' });
    if (activeProcess) return res.status(409).json({ error: 'agent is busy' });
    orchestrate(prompt.trim());  // Phase 5: orchestrate if employees exist
    res.json({ ok: true });
});

// Clear (messages only, memory preserved)
app.post('/api/clear', (_, res) => {
    clearMessages.run();
    const session = getSession();
    updateSession.run(session.active_cli, null, session.model, session.permissions, session.working_dir, session.effort);
    broadcast('clear', {});
    res.json({ ok: true });
});

// Settings
app.get('/api/settings', (_, res) => res.json(settings));
app.put('/api/settings', (req, res) => {
    const prevCli = settings.cli;
    const hasTelegramUpdate = !!req.body.telegram; // 6.6: capture before deep merge deletes it

    // Deep merge for nested objects
    for (const key of ['perCli', 'planning', 'heartbeat', 'telegram']) {
        if (req.body[key] && typeof req.body[key] === 'object') {
            settings[key] = { ...settings[key], ...req.body[key] };
            delete req.body[key];
        }
    }
    settings = { ...settings, ...req.body };
    saveSettings(settings);

    const session = getSession();
    const activeModel = settings.perCli?.[settings.cli]?.model || 'default';
    const activeEffort = settings.perCli?.[settings.cli]?.effort || 'medium';

    // 5.9: CLI changed → invalidate session (can't resume cross-CLI)
    const sessionId = (settings.cli !== prevCli) ? null : session.session_id;
    if (settings.cli !== prevCli && session.session_id) {
        console.log(`[claw:session] invalidated — CLI changed ${prevCli} → ${settings.cli}`);
    }

    updateSession.run(
        settings.cli, sessionId, activeModel,
        settings.permissions, settings.workingDir, activeEffort
    );

    // 6.6: Reinit telegram if settings changed
    if (hasTelegramUpdate) initTelegram();

    res.json(settings);
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

// Memory
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

// CLI detection
app.get('/api/cli-status', (_, res) => res.json(detectAllCli()));

// Quota (ported from claw-lite)
app.get('/api/quota', async (_, res) => {
    const [claude, codex] = await Promise.all([
        fetchClaudeUsage(readClaudeCreds()),
        fetchCodexUsage(readCodexTokens()),
    ]);
    const gemini = readGeminiAccount();
    res.json({ claude, codex, gemini, opencode: null });
});

// Employees (sub-agents)
app.get('/api/employees', (_, res) => res.json(getEmployees.all()));
app.post('/api/employees', (req, res) => {
    const id = crypto.randomUUID();
    const { name = 'New Agent', cli = 'claude', model = 'default', role = '' } = req.body || {};
    insertEmployee.run(id, name, cli, model, role);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    broadcast('agent_added', emp);
    regenerateB();  // Update B.md with new employee
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
    regenerateB();  // Update B.md with modified employee
    res.json(emp);
});
app.delete('/api/employees/:id', (req, res) => {
    deleteEmployee.run(req.params.id);
    broadcast('agent_deleted', { id: req.params.id });
    regenerateB();  // Update B.md without deleted employee
    res.json({ ok: true });
});

// ─── Telegram Bot (Phase 6) ──────────────────────────

function escapeHtmlTg(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToTelegramHtml(md) {
    if (!md) return '';
    let html = escapeHtmlTg(md);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/(?<![*])\*(?![*])(.+?)(?<![*])\*(?![*])/g, '<i>$1</i>');
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
    return html;
}

function chunkTelegramMessage(text, limit = 4096) {
    if (text.length <= limit) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n', limit);
        if (splitAt < limit * 0.3) splitAt = limit;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
    }
    return chunks;
}

function orchestrateAndCollect(prompt) {
    return new Promise((resolve) => {
        let collected = '';
        let timeout;
        const handler = (type, data) => {
            if (type === 'agent_output') collected += data.text || '';
            if (type === 'agent_done') {
                clearTimeout(timeout);
                removeBroadcastListener(handler);
                resolve(data.text || collected || '응답 없음');
            }
        };
        addBroadcastListener(handler);
        orchestrate(prompt).catch(err => {
            clearTimeout(timeout);
            removeBroadcastListener(handler);
            resolve(`❌ ${err.message}`);
        });
        timeout = setTimeout(() => {
            removeBroadcastListener(handler);
            resolve(collected || '⏰ 시간 초과 (2분)');
        }, 120000);
    });
}

let telegramBot = null;

function initTelegram() {
    if (telegramBot) {
        const old = telegramBot;
        telegramBot = null;
        try { old.stop(); } catch { }
    }
    if (!settings.telegram?.enabled || !settings.telegram?.token) {
        console.log('[tg] Telegram disabled or no token');
        return;
    }

    // Node 22: native fetch (undici) ignores autoSelectFamily and fails on IPv6-broken networks
    // Only https.get({family:4}) works. Build a minimal fetch wrapper for grammy.
    // Ref: openclaw-ref/src/telegram/fetch.ts, nodejs/node#54359
    const ipv4Agent = new https.Agent({ family: 4 });
    const ipv4Fetch = (url, init = {}) => {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const opts = {
                hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
                method: init.method || 'GET', agent: ipv4Agent,
                headers: init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers || {}),
            };
            const req = https.request(opts, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: () => Promise.resolve(JSON.parse(data)),
                    text: () => Promise.resolve(data),
                }));
            });
            req.on('error', reject);
            if (init.body) req.write(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
            req.end();
        });
    };

    const bot = new Bot(settings.telegram.token, {
        client: { fetch: ipv4Fetch },
    });
    bot.catch((err) => console.error('[tg:error]', err.message || err));
    bot.use(sequentialize((ctx) => `tg:${ctx.chat?.id || 'unknown'}`));

    // Debug: log all incoming updates
    bot.use(async (ctx, next) => {
        console.log(`[tg:update] chat=${ctx.chat?.id} text=${(ctx.message?.text || '').slice(0, 40)}`);
        await next();
    });

    // Allowlist
    bot.use(async (ctx, next) => {
        const allowed = settings.telegram.allowedChatIds;
        if (allowed?.length > 0 && !allowed.includes(ctx.chat?.id)) {
            console.log(`[tg:blocked] chatId=${ctx.chat?.id}`);
            return;
        }
        await next();
    });

    bot.command('start', (ctx) => ctx.reply('🦞 Claw Agent 연결됨! 메시지를 보내면 AI 에이전트가 응답합니다.'));
    bot.command('id', (ctx) => ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' }));

    bot.on('message:text', async (ctx) => {
        const text = ctx.message.text;
        if (text.startsWith('/')) return;

        console.log(`[tg:in] ${ctx.chat.id}: ${text.slice(0, 80)}`);

        // Save user message to DB + sync to Web UI (6.2)
        insertMessage.run('user', text, 'telegram', '');
        broadcast('new_message', { role: 'user', content: text, source: 'telegram' });

        await ctx.replyWithChatAction('typing').catch(e => console.log('[tg:typing]', e.message));
        const typingInterval = setInterval(() => {
            ctx.replyWithChatAction('typing').catch(() => { });
        }, 4000);

        try {
            const result = await orchestrateAndCollect(text);
            clearInterval(typingInterval);

            const html = markdownToTelegramHtml(result);
            const chunks = chunkTelegramMessage(html);
            for (const chunk of chunks) {
                try {
                    await ctx.reply(chunk, { parse_mode: 'HTML' });
                } catch {
                    await ctx.reply(chunk.replace(/<[^>]+>/g, ''));
                }
            }

            // Note: assistant message already saved + broadcast as agent_done by spawnAgent
            console.log(`[tg:out] ${ctx.chat.id}: ${result.slice(0, 80)}`);
        } catch (err) {
            clearInterval(typingInterval);
            console.error('[tg:error]', err);
            await ctx.reply(`❌ Error: ${err.message}`);
        }
    });

    // bot.start() handles init internally — don't call bot.init() separately
    bot.start({
        drop_pending_updates: true,
        onStart: (info) => console.log(`[tg] ✅ @${info.username} polling active`),
    });
    telegramBot = bot;
    console.log('[tg] Bot starting...');
}

// ─── Heartbeat (Phase 8.2) ───────────────────────────

const heartbeatTimers = new Map();
let heartbeatBusy = false;

function loadHeartbeatFile() {
    try {
        return JSON.parse(fs.readFileSync(HEARTBEAT_JOBS_PATH, 'utf8'));
    } catch {
        return { jobs: [] };
    }
}

function saveHeartbeatFile(data) {
    fs.writeFileSync(HEARTBEAT_JOBS_PATH, JSON.stringify(data, null, 2));
}

function startHeartbeat() {
    stopHeartbeat();
    const { jobs } = loadHeartbeatFile();
    for (const job of jobs) {
        if (!job.enabled || job.schedule?.kind !== 'every') continue;
        const ms = (job.schedule.minutes || 5) * 60_000;
        const timer = setInterval(() => runHeartbeatJob(job), ms);
        timer.unref?.();
        heartbeatTimers.set(job.id, timer);
    }
    const n = heartbeatTimers.size;
    console.log(`[heartbeat] ${n} job${n !== 1 ? 's' : ''} active`);
}

function stopHeartbeat() {
    for (const timer of heartbeatTimers.values()) clearInterval(timer);
    heartbeatTimers.clear();
}

async function runHeartbeatJob(job) {
    if (heartbeatBusy) {
        console.log(`[heartbeat:${job.name}] skipped — busy`);
        return;
    }
    heartbeatBusy = true;
    try {
        const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const prompt = `[heartbeat:${job.name}] 현재 시간: ${now}\n\n${job.prompt || '정기 점검입니다. 할 일 없으면 [SILENT]로 응답.'}`;
        console.log(`[heartbeat:${job.name}] tick`);
        const result = await orchestrateAndCollect(prompt);

        if (result.includes('[SILENT]')) {
            console.log(`[heartbeat:${job.name}] silent`);
            return;
        }

        console.log(`[heartbeat:${job.name}] response: ${result.slice(0, 80)}`);

        // Telegram 전달
        if (telegramBot && settings.telegram?.enabled) {
            const chatIds = settings.telegram.allowedChatIds || [];
            const html = markdownToTelegramHtml(result);
            const chunks = chunkTelegramMessage(html);
            for (const chatId of chatIds) {
                for (const chunk of chunks) {
                    try {
                        await telegramBot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
                    } catch {
                        await telegramBot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ''));
                    }
                }
            }
        }
    } catch (err) {
        console.error(`[heartbeat:${job.name}] error:`, err.message);
    } finally {
        heartbeatBusy = false;
    }
}

// fs.watch — AI나 사용자가 파일 직접 편집 시 자동 리로드
try {
    let watchDebounce = null;
    fs.watch(HEARTBEAT_JOBS_PATH, () => {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
            console.log('[heartbeat] file changed — reloading');
            startHeartbeat();
        }, 500);
    });
} catch { /* 파일 없으면 무시 — 첫 저장 시 생성 */ }

// API endpoints
app.get('/api/heartbeat', (req, res) => {
    res.json(loadHeartbeatFile());
});

app.put('/api/heartbeat', (req, res) => {
    const data = req.body;
    if (!data || !Array.isArray(data.jobs)) {
        return res.status(400).json({ error: 'jobs array required' });
    }
    saveHeartbeatFile(data);
    startHeartbeat();
    res.json(data);
});

// ─── Start ───────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`\n  🦞 Claw Agent — http://localhost:${PORT}\n`);
    console.log(`  CLI:    ${settings.cli}`);
    console.log(`  Perms:  ${settings.permissions}`);
    console.log(`  CWD:    ${settings.workingDir}`);
    console.log(`  DB:     ${DB_PATH}`);
    console.log(`  Prompts: ${PROMPTS_DIR}\n`);
    initTelegram();
    startHeartbeat();
});
