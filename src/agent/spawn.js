// ─── Agent Spawn + Kill/Steer/Queue ──────────────────

import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { broadcast } from '../core/bus.js';
import { settings, UPLOADS_DIR, detectCli } from '../core/config.js';
import {
    getSession, updateSession, insertMessage, insertMessageWithTrace, getRecentMessages, getEmployees,
} from '../core/db.js';
import { getSystemPrompt } from '../prompt/builder.js';
import { extractSessionId, extractFromEvent, extractFromAcpUpdate, logEventSummary } from './events.js';
import { saveUpload as _saveUpload, buildMediaPrompt } from '../../lib/upload.js';

// ─── State ───────────────────────────────────────────

export let activeProcess = null;
export let memoryFlushCounter = 0;
export let flushCycleCount = 0;
export const messageQueue = [];

// ─── Kill / Steer ────────────────────────────────────

export function killActiveAgent(reason = 'user') {
    if (!activeProcess) return false;
    console.log(`[claw:kill] reason=${reason}`);
    try { activeProcess.kill('SIGTERM'); } catch (e) { console.warn('[agent:kill] SIGTERM failed', { pid: activeProcess?.pid, error: e.message }); }
    const proc = activeProcess;
    setTimeout(() => {
        try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch (e) { console.warn('[agent:kill] SIGKILL failed', { pid: proc?.pid, error: e.message }); }
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
    const { orchestrate, orchestrateContinue, isContinueIntent } = await import('./orchestrator.js');
    const origin = source || 'web';
    if (isContinueIntent(newPrompt)) orchestrateContinue({ origin });
    else orchestrate(newPrompt, { origin });
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
    const { orchestrate, orchestrateContinue, isContinueIntent } = await import('./orchestrator.js');
    const origin = source || 'web';
    if (isContinueIntent(combined)) orchestrateContinue({ origin });
    else orchestrate(combined, { origin });
}

// ─── Helpers ─────────────────────────────────────────

function makeCleanEnv() {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.GEMINI_SYSTEM_MD;
    return env;
}

function buildHistoryBlock(currentPrompt, maxSessions = 5, maxTotalChars = 8000) {
    const recent = getRecentMessages.all(Math.max(1, maxSessions * 2));
    if (!recent.length) return '';

    const promptText = String(currentPrompt || '').trim();
    let skipCurrentPromptBudget = 2;
    const blocks = [];
    let charCount = 0;

    for (let i = 0; i < recent.length; i++) {
        const row = recent[i];
        const role = String(row.role || '');
        const content = String(row.content || '').trim();

        // Exclude the just-inserted current prompt when caller path stores user text
        // before spawn (e.g. steer/telegram/queue paths).
        if (promptText && i < 3 && skipCurrentPromptBudget > 0 && role === 'user' && content === promptText) {
            skipCurrentPromptBudget--;
            continue;
        }

        const entry = role === 'assistant' && row.trace
            ? String(row.trace).trim()
            : (content ? `[${role || 'user'}] ${content}` : '');
        if (!entry) continue;
        if (charCount + entry.length > maxTotalChars) break;
        blocks.push(entry);
        charCount += entry.length;
    }

    if (!blocks.length) return '';
    return `[Recent Context]\n${blocks.reverse().join('\n\n')}`;
}

function withHistoryPrompt(prompt, historyBlock) {
    const body = String(prompt || '');
    if (!historyBlock) return body;
    return `${historyBlock}\n\n---\n[Current Message]\n${body}`;
}

import { buildArgs, buildResumeArgs } from './args.js';
export { buildArgs, buildResumeArgs };

// ─── Upload wrapper ──────────────────────────────────

export const saveUpload = (buffer, originalName) => _saveUpload(UPLOADS_DIR, buffer, originalName);
export { buildMediaPrompt };

// ─── Spawn Agent ─────────────────────────────────────

import { stripSubtaskJSON } from '../orchestrator/pipeline.js';
import { AcpClient } from '../cli/acp-client.js';

export function spawnAgent(prompt, opts = {}) {
    const { forceNew = false, agentId, sysPrompt: customSysPrompt } = opts;
    const origin = opts.origin || 'web';
    const employeeSessionId = opts.sessionId || null;
    const mainManaged = !forceNew && !employeeSessionId;

    if (activeProcess && mainManaged) {
        console.log('[claw] Agent already running, skipping');
        return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
    }

    let resolve;
    const resultPromise = new Promise(r => { resolve = r; });

    const session = getSession();
    const cli = opts.cli || session.active_cli || settings.cli;
    const permissions = opts.permissions || settings.permissions || session.permissions || 'auto';
    const cfg = settings.perCli?.[cli] || {};
    const ao = (!opts.internal && !opts.agentId) ? (settings.activeOverrides?.[cli] || {}) : {};
    const model = opts.model || ao.model || cfg.model || 'default';
    const effort = opts.effort || ao.effort || cfg.effort || '';

    const sysPrompt = customSysPrompt || getSystemPrompt();

    const isResume = !forceNew && (employeeSessionId || (session.session_id && session.active_cli === cli));
    const resumeSessionId = employeeSessionId || session.session_id;
    const historyBlock = !isResume ? buildHistoryBlock(prompt) : '';
    const promptForArgs = (cli === 'gemini' || cli === 'opencode')
        ? withHistoryPrompt(prompt, historyBlock)
        : prompt;
    let args;
    if (isResume) {
        console.log(`[claw:resume] ${cli} session=${resumeSessionId.slice(0, 12)}...`);
        args = buildResumeArgs(cli, model, effort, resumeSessionId, prompt, permissions);
    } else {
        args = buildArgs(cli, model, effort, promptForArgs, sysPrompt, permissions);
    }

    const agentLabel = agentId || 'main';
    if (cli === 'copilot') {
        console.log(`[claw:${agentLabel}] Spawning: copilot --acp --model ${model} [${permissions}]`);
    } else {
        console.log(`[claw:${agentLabel}] Spawning: ${cli} ${args.join(' ').slice(0, 120)}...`);
    }

    const spawnEnv = makeCleanEnv();

    if (cli === 'gemini' && sysPrompt) {
        const tmpSysFile = join(os.tmpdir(), `claw-gemini-sys-${agentLabel}.md`);
        fs.writeFileSync(tmpSysFile, sysPrompt);
        spawnEnv.GEMINI_SYSTEM_MD = tmpSysFile;
    }

    // ─── Copilot ACP branch ──────────────────────
    if (cli === 'copilot') {
        // Write model + reasoning_effort to ~/.copilot/config.json (CLI flags unsupported)
        try {
            const cfgPath = join(os.homedir(), '.copilot', 'config.json');
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            let changed = false;

            // Sync model
            if (model && model !== 'default') {
                if (cfg.model !== model) { cfg.model = model; changed = true; }
            }

            // Sync effort
            if (effort) {
                if (cfg.reasoning_effort !== effort) { cfg.reasoning_effort = effort; changed = true; }
            } else if (cfg.reasoning_effort) {
                delete cfg.reasoning_effort; changed = true;
            }

            if (changed) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        } catch (e) { console.warn('[claw:copilot] config.json sync failed:', e.message); }

        const acp = new AcpClient({ model, workDir: settings.workingDir, permissions });
        acp.spawn();
        const child = acp.proc;
        if (mainManaged) activeProcess = child;
        broadcast('agent_status', { running: true, agentId: agentLabel, cli });

        if (mainManaged && !opts.internal && !opts._skipInsert) {
            insertMessage.run('user', prompt, cli, model);
        }
        broadcast('agent_status', { status: 'running', cli, agentId: agentLabel });

        const ctx = {
            fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set(),
            hasClaudeStreamEvents: false, sessionId: null, cost: null,
            turns: null, duration: null, tokens: null, stderrBuf: '',
            thinkingBuf: '',
        };

        // Flush accumulated 💭 thinking buffer as a single merged event
        function flushThinking() {
            if (!ctx.thinkingBuf) return;
            const merged = ctx.thinkingBuf.trim();
            if (merged) {
                const display = merged.length > 200 ? '…' + merged.slice(-197) : merged;
                console.log(`  💭 ${display.slice(0, 120)}`);
                const tool = { icon: '💭', label: display };
                ctx.toolLog.push(tool);
                broadcast('agent_tool', { agentId: agentLabel, ...tool });
            }
            ctx.thinkingBuf = '';
        }

        // session/update → broadcast mapping
        let replayMode = false;  // Phase 17.2: suppress events during loadSession replay
        acp.on('session/update', (params) => {
            if (replayMode) return;  // 리플레이 중 모든 이벤트 무시
            const parsed = extractFromAcpUpdate(params);
            if (!parsed) return;

            if (parsed.tool) {
                // Buffer 💭 thought chunks → flush when different event arrives
                if (parsed.tool.icon === '💭') {
                    ctx.thinkingBuf += parsed.tool.label;
                    return;
                }
                // Non-💭 tool → flush any pending thinking first
                flushThinking();
                const key = `${parsed.tool.icon}:${parsed.tool.label}`;
                if (!ctx.seenToolKeys.has(key)) {
                    ctx.seenToolKeys.add(key);
                    ctx.toolLog.push(parsed.tool);
                    broadcast('agent_tool', { agentId: agentLabel, ...parsed.tool });
                }
            }
            if (parsed.text) {
                flushThinking();
                ctx.fullText += parsed.text;
            }
        });

        // Run ACP flow
        (async () => {
            try {
                const initResult = await acp.initialize();
                if (process.env.DEBUG) console.log('[acp:init]', JSON.stringify(initResult).slice(0, 200));

                replayMode = true;  // Phase 17.2: mute during session load
                if (isResume && resumeSessionId) {
                    try {
                        await acp.loadSession(resumeSessionId);
                    } catch {
                        await acp.createSession(settings.workingDir);
                    }
                } else {
                    await acp.createSession(settings.workingDir);
                }
                replayMode = false;  // Phase 17.2: unmute after session load
                ctx.sessionId = acp.sessionId;

                // Reset accumulated text from loadSession replay (ACP replays full history)
                ctx.fullText = '';
                ctx.toolLog = [];
                ctx.seenToolKeys.clear();
                ctx.thinkingBuf = '';  // Phase 17.2: clear replay thinking too

                const { promise: promptPromise } = acp.prompt(prompt);
                const promptResult = await promptPromise;
                if (process.env.DEBUG) console.log('[acp:prompt:result]', JSON.stringify(promptResult).slice(0, 200));

                await acp.shutdown();
            } catch (err) {
                console.error(`[acp:error] ${err.message}`);
                ctx.stderrBuf += err.message;
                acp.kill();
            }
        })();

        acp.on('exit', ({ code, signal }) => {
            flushThinking();  // Flush any remaining thinking buffer
            if (mainManaged) {
                activeProcess = null;
                broadcast('agent_status', { running: false, agentId: agentLabel });
            }

            if (mainManaged && ctx.sessionId && code === 0) {
                updateSession.run(cli, ctx.sessionId, model, settings.permissions, settings.workingDir, cfg.effort || '');
            }

            if (ctx.fullText.trim()) {
                const stripped = stripSubtaskJSON(ctx.fullText);
                const cleaned = (stripped || ctx.fullText.trim())
                    .replace(/<\/?tool_call>/g, '')
                    .replace(/<\/?tool_result>[\s\S]*?(?:<\/tool_result>|$)/g, '')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                const finalContent = cleaned || ctx.fullText.trim();
                const traceText = ctx.traceLog.join('\n');

                if (mainManaged && !opts.internal) {
                    insertMessageWithTrace.run('assistant', finalContent, cli, model, traceText || null);
                    broadcast('agent_done', { text: finalContent, toolLog: ctx.toolLog, origin });
                    memoryFlushCounter++;
                }
            } else if (mainManaged && code !== 0) {
                let errMsg = `Copilot CLI 실행 실패 (exit ${code})`;
                if (ctx.stderrBuf.includes('auth')) errMsg = '🔐 인증 오류 — 1) gh auth login → 2) gh copilot --help → 3) copilot login';
                else if (ctx.stderrBuf.trim()) errMsg = ctx.stderrBuf.trim().slice(0, 200);

                if (!opts.internal && !opts._isFallback) {
                    const fallbackCli = (settings.fallbackOrder || [])
                        .find(fc => fc !== cli && detectCli(fc).available);
                    if (fallbackCli) {
                        broadcast('agent_fallback', { from: cli, to: fallbackCli, reason: errMsg });
                        const { promise: retryP } = spawnAgent(prompt, {
                            ...opts, cli: fallbackCli, _isFallback: true, _skipInsert: true,
                        });
                        retryP.then(r => resolve(r));
                        return;
                    }
                }
                broadcast('agent_done', { text: `❌ ${errMsg}`, error: true, origin });
            }

            broadcast('agent_status', { status: code === 0 ? 'done' : 'error', agentId: agentLabel });
            resolve({ text: ctx.fullText, code: code ?? 1, sessionId: ctx.sessionId, tools: ctx.toolLog });
            if (mainManaged) processQueue();
        });

        return { child, promise: resultPromise };
    }

    // ─── Standard CLI branch (claude/codex/gemini/opencode) ──────
    const child = spawn(cli, args, {
        cwd: settings.workingDir,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (mainManaged) activeProcess = child;
    broadcast('agent_status', { running: true, agentId: agentLabel, cli });

    if (mainManaged && !opts.internal && !opts._skipInsert) {
        insertMessage.run('user', prompt, cli, model);
    }

    if (cli === 'claude') {
        child.stdin.write(withHistoryPrompt(prompt, historyBlock));
    } else if (cli === 'codex' && !isResume) {
        const codexStdin = historyBlock
            ? `${historyBlock}\n\n[User Message]\n${prompt}`
            : `[User Message]\n${prompt}`;
        child.stdin.write(codexStdin);
    }
    child.stdin.end();

    broadcast('agent_status', { status: 'running', cli, agentId: agentLabel });

    const ctx = {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
    };
    let buffer = '';

    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line);
                if (process.env.DEBUG) {
                    console.log(`[claw:event:${agentLabel}] ${cli} type=${event.type}`);
                    console.log(`[claw:raw:${agentLabel}] ${line.slice(0, 300)}`);
                }
                logEventSummary(agentLabel, cli, event, ctx);
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
        if (mainManaged) {
            activeProcess = null;
            broadcast('agent_status', { running: false, agentId: agentLabel });
        }

        if (mainManaged && ctx.sessionId && code === 0) {
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
            // Strip raw XML tool tags (Claude sometimes includes these in output)
            const cleaned = (stripped || ctx.fullText.trim())
                .replace(/<\/?tool_call>/g, '')
                .replace(/<\/?tool_result>[\s\S]*?(?:<\/tool_result>|$)/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            const displayText = cleaned || ctx.fullText.trim();
            const finalContent = displayText + costLine;
            const traceText = ctx.traceLog.join('\n');

            if (mainManaged && !opts.internal) {
                insertMessageWithTrace.run('assistant', finalContent, cli, model, traceText || null);
                broadcast('agent_done', { text: finalContent, toolLog: ctx.toolLog, origin });

                memoryFlushCounter++;
                const threshold = settings.memory?.flushEvery ?? 20;
                if (settings.memory?.enabled !== false && memoryFlushCounter >= threshold) {
                    memoryFlushCounter = 0;
                    flushCycleCount++;
                    triggerMemoryFlush();
                }
            }
        } else if (mainManaged && code !== 0) {
            let errMsg = `CLI 실행 실패 (exit ${code})`;
            if (ctx.stderrBuf.includes('429') || ctx.stderrBuf.includes('RESOURCE_EXHAUSTED')) {
                errMsg = '⚡ API 용량 초과 (429) — 잠시 후 다시 시도해주세요';
            } else if (ctx.stderrBuf.includes('auth') || ctx.stderrBuf.includes('credentials')) {
                errMsg = '🔐 인증 오류 — CLI 로그인 상태를 확인해주세요';
            } else if (ctx.stderrBuf.trim()) {
                errMsg = ctx.stderrBuf.trim().slice(0, 200);
            }

            // ─── Fallback: 1회 재시도 ─────────────────────
            if (!opts.internal && !opts._isFallback) {
                const fallbackCli = (settings.fallbackOrder || [])
                    .find(fc => fc !== cli && detectCli(fc).available);
                if (fallbackCli) {
                    console.log(`[claw:fallback] ${cli} failed (exit ${code}) → ${fallbackCli}`);
                    broadcast('agent_fallback', { from: cli, to: fallbackCli, reason: errMsg });
                    const { promise: retryP } = spawnAgent(prompt, {
                        ...opts, cli: fallbackCli, _isFallback: true, _skipInsert: true,
                    });
                    retryP.then(r => resolve(r));
                    return;
                }
            }

            broadcast('agent_done', { text: `❌ ${errMsg}`, error: true, origin });
        }

        broadcast('agent_status', { status: code === 0 ? 'done' : 'error', agentId: agentLabel });
        console.log(`[claw:${agentLabel}] exited code=${code}, text=${ctx.fullText.length} chars`);

        resolve({ text: ctx.fullText, code, sessionId: ctx.sessionId, cost: ctx.cost, tools: ctx.toolLog });

        if (mainManaged) processQueue();
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
