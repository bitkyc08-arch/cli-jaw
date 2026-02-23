// ─── Agent Spawn + Kill/Steer/Queue ──────────────────

import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { broadcast } from './bus.js';
import { settings, UPLOADS_DIR } from './config.js';
import {
    getSession, updateSession, insertMessage, getRecentMessages, getEmployees,
} from './db.js';
import { getSystemPrompt } from './prompt.js';
import { extractSessionId, extractFromEvent } from './events.js';
import { saveUpload as _saveUpload, buildMediaPrompt } from '../lib/upload.js';

// ─── State ───────────────────────────────────────────

export let activeProcess = null;
export let memoryFlushCounter = 0;
export const messageQueue = [];

// ─── Kill / Steer ────────────────────────────────────

export function killActiveAgent(reason = 'user') {
    if (!activeProcess) return false;
    console.log(`[claw:kill] reason=${reason}`);
    try { activeProcess.kill('SIGTERM'); } catch { }
    const proc = activeProcess;
    setTimeout(() => {
        try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch { }
    }, 2000);
    return true;
}

export function waitForProcessEnd(timeoutMs = 3000) {
    if (!activeProcess) return Promise.resolve();
    return new Promise(resolve => {
        const check = setInterval(() => {
            if (!activeProcess) { clearInterval(check); resolve(); }
        }, 100);
        setTimeout(() => { clearInterval(check); resolve(); }, timeoutMs);
    });
}

export async function steerAgent(newPrompt, source) {
    const wasRunning = killActiveAgent('steer');
    if (wasRunning) await waitForProcessEnd(3000);
    insertMessage.run('user', newPrompt, source, '');
    broadcast('new_message', { role: 'user', content: newPrompt, source });
    const { orchestrate } = await import('./orchestrator.js');
    orchestrate(newPrompt);
}

// ─── Message Queue ───────────────────────────────────

export function enqueueMessage(prompt, source) {
    messageQueue.push({ prompt, source, ts: Date.now() });
    console.log(`[queue] +1 (${messageQueue.length} pending)`);
    broadcast('queue_update', { pending: messageQueue.length });
}

export async function processQueue() {
    if (activeProcess || messageQueue.length === 0) return;
    const batched = messageQueue.splice(0);
    const combined = batched.length === 1
        ? batched[0].prompt
        : batched.map(m => m.prompt).join('\n\n---\n\n');
    const source = batched[batched.length - 1].source;
    console.log(`[queue] processing ${batched.length} queued message(s)`);
    insertMessage.run('user', combined, source, '');
    broadcast('new_message', { role: 'user', content: combined, source });
    broadcast('queue_update', { pending: 0 });
    const { orchestrate } = await import('./orchestrator.js');
    orchestrate(combined);
}

// ─── Helpers ─────────────────────────────────────────

function makeCleanEnv() {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.GEMINI_SYSTEM_MD;
    return env;
}

export function buildArgs(cli, model, effort, prompt, sysPrompt) {
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
                '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json'];
        case 'gemini':
            return ['-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '-y', '-o', 'stream-json'];
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

export function buildResumeArgs(cli, model, effort, sessionId, prompt) {
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
                '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
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

// ─── Upload wrapper ──────────────────────────────────

export const saveUpload = (buffer, originalName) => _saveUpload(UPLOADS_DIR, buffer, originalName);
export { buildMediaPrompt };

// ─── Spawn Agent ─────────────────────────────────────

import { stripSubtaskJSON } from './orchestrator.js';

export function spawnAgent(prompt, opts = {}) {
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

    const sysPrompt = customSysPrompt || getSystemPrompt();

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
    broadcast('agent_status', { running: true, agentId: agentLabel, cli });

    if (!forceNew && !opts.internal) {
        insertMessage.run('user', prompt, cli, model);
    }

    const skipStdin = cli === 'gemini' || cli === 'opencode' || (cli === 'codex' && isResume);
    if (!skipStdin) {
        const sp = customSysPrompt || getSystemPrompt();
        let stdinContent = `[Claw Platform Context]\n${sp}`;
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
        if (!forceNew) {
            activeProcess = null;
            broadcast('agent_status', { running: false, agentId: agentLabel });
        }

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
            const stripped = stripSubtaskJSON(ctx.fullText);
            const displayText = stripped || ctx.fullText.trim();
            const finalContent = displayText + costLine;

            if (!forceNew && !opts.internal) {
                insertMessage.run('assistant', finalContent, cli, model);
                broadcast('agent_done', { text: finalContent, toolLog: ctx.toolLog });

                memoryFlushCounter++;
                const threshold = settings.memory?.flushEvery ?? 20;
                if (settings.memory?.enabled !== false && memoryFlushCounter >= threshold) {
                    memoryFlushCounter = 0;
                    triggerMemoryFlush();
                }
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

        if (!forceNew) processQueue();
    });

    return { child, promise: resultPromise };
}

// ─── Memory Flush ────────────────────────────────────

async function triggerMemoryFlush() {
    const { getMemoryDir } = await import('./prompt.js');
    const memDir = getMemoryDir();
    const threshold = settings.memory?.flushEvery ?? 20;
    const recent = getRecentMessages.all(threshold).reverse();
    if (recent.length < 4) return;

    const lines = [];
    for (const m of recent) {
        lines.push(`[${m.role}] ${m.content}`);
    }
    const convo = lines.join('\n\n');
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toTimeString().slice(0, 5);
    const memFile = join(memDir, `${date}.md`);

    const flushPrompt = `You are a memory extractor. Summarize the conversation into a short prose paragraph.
Save by APPENDING to: ${memFile}
Create directories if needed.

Rules:
- Write 1-3 SHORT English sentences capturing decisions, facts, preferences only
- Skip greetings, errors, small talk
- If nothing worth remembering, reply "SKIP" and do NOT write any file
- Format:

## ${time}

[your 1-3 sentence summary here]

Conversation:
---
${convo}`;

    fs.mkdirSync(memDir, { recursive: true });

    const flushCli = settings.memory?.cli || settings.cli;
    const flushModel = settings.memory?.model || (settings.perCli?.[flushCli]?.model) || 'default';

    spawnAgent(flushPrompt, {
        forceNew: true,
        internal: true,
        agentId: 'memory-flush',
        cli: flushCli,
        model: flushModel,
        sysPrompt: '',
    });
    console.log(`[memory] flush triggered (${recent.length} msgs → ${flushCli}/${flushModel})`);
}
