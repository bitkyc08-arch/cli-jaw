// ─── Memory Flush Controller ─────────────────────────
// Extracted from spawn.ts to reduce file size.

import fs from 'fs';
import { join } from 'path';
import { settings, JAW_HOME } from '../core/config.js';
import { getRecentMessages } from '../core/db.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { currentSessionScope } from '../core/session-context.js';
import { getMemoryFlushFilePath } from '../memory/runtime.js';
import { maybeAutoReflect } from '../memory/reflect.js';
import { resolveDashboardHome } from '../manager/dashboard-home.js';
import { DASHBOARD_DEFAULT_PORT } from '../manager/constants.js';

export let memoryFlushCounter = 0;
export let flushCycleCount = 0;
let _flushLock = false;
let _lastFlushedMessageId: number | null = null;
let _flushGeneration = 0;
let _activeFlushGeneration: number | null = null;

const FLUSH_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FLUSH_OUTPUT_BYTES = 64 * 1024;
const SESSION_HEADING_RE = /^##\s.*\bsession:[^\s]+/i;

export function incrementMemoryFlush(): void {
    memoryFlushCounter++;
}

export function resetMemoryFlushCounter(): void {
    memoryFlushCounter = 0;
    flushCycleCount++;
}

type FlushSpawnResult = {
    text: string;
    code: number;
};

type FlushSpawnOptions = {
    agentId: string;
    internal: boolean;
    forceNew: boolean;
    _skipInsert: boolean;
    _skipHistory: boolean;
    cli: string;
    model: string;
    sysPrompt: string;
};

type FlushSpawnAgent = (
    prompt: string,
    opts: FlushSpawnOptions,
) => { child: unknown; promise: Promise<FlushSpawnResult> };

// Forward reference to spawnAgent (avoid circular import)
let _spawnAgent: FlushSpawnAgent;

export function setSpawnRef(fn: FlushSpawnAgent, _procs: unknown): void {
    _spawnAgent = fn;
}

// ─── Flush Prompt Builder (3-A) ──────────────────────

const DEFAULT_FLUSH_PROMPT_TEMPLATE = `You are a memory extractor. Return a short prose summary of the conversation.

Rules:
- Return only 1-3 SHORT English sentences capturing decisions, facts, preferences
- Skip greetings, errors, small talk
- If nothing worth remembering, return exactly "SKIP"
- Do not write or modify any file

Conversation:
---
{{convo}}`;

export function buildFlushPrompt(vars: { memFile: string; time: string; convo: string; sessionId?: string }): string {
    const customPath = join(JAW_HOME, 'prompts', 'flush-prompt.md');
    let template = DEFAULT_FLUSH_PROMPT_TEMPLATE;
    if (fs.existsSync(customPath)) {
        try {
            template = fs.readFileSync(customPath, 'utf8');
        } catch (err) {
            console.warn(`[memory] failed to load custom flush prompt: ${(err as Error).message}`);
        }
    }
    const safeVars: Record<string, string> = { memFile: vars.memFile, time: vars.time, convo: vars.convo };
    if (settings["multiSession"]?.enabled === true && vars.sessionId) {
        safeVars["sessionId"] = vars.sessionId;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => safeVars[key] ?? match);
}

// ─── Flush SysPrompt Loader (3-B) ───────────────────

function loadFlushSysPrompt(): string {
    const customPath = join(JAW_HOME, 'prompts', 'flush-system.md');
    if (fs.existsSync(customPath)) {
        try {
            return fs.readFileSync(customPath, 'utf8');
        } catch (err) {
            console.warn(`[memory] failed to load flush system prompt: ${(err as Error).message}`);
        }
    }
    return '';
}

// ─── Trigger ─────────────────────────────────────────

export async function triggerMemoryFlush(): Promise<void> {
    if (_flushLock) {
        console.log('[memory] flush lock held, skipping');
        return;
    }

    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const sessionId = multiSessionEnabled
        ? (currentSessionScope()?.chatSessionId ?? getActiveChatSession())
        : getActiveChatSession();
    const threshold = settings["memory"]?.flushEvery ?? 10;
    const recent = (getRecentMessages.all(settings["workingDir"] || null, sessionId, threshold) as any[])
        .filter((m: any) => !_lastFlushedMessageId || m.id > _lastFlushedMessageId)
        .reverse();
    if (recent.length < 4) return;

    const generation = ++_flushGeneration;
    _flushLock = true;
    _activeFlushGeneration = generation;
    let expired = false;
    let released = false;

    const ownsGeneration = (): boolean =>
        !expired && _flushLock && _activeFlushGeneration === generation;
    const releaseLock = (): void => {
        if (released) return;
        released = true;
        if (_activeFlushGeneration === generation) {
            _activeFlushGeneration = null;
            _flushLock = false;
        }
    };
    const lockTimeout = setTimeout(() => {
        if (ownsGeneration()) {
            expired = true;
            releaseLock();
            console.warn('[memory] flush lock auto-released after 5m timeout');
        }
    }, FLUSH_LOCK_TIMEOUT_MS);

    const maxId = Math.max(...recent.map((m: any) => m.id));

    const lines = [];
    for (const m of recent) {
        lines.push(`[${m.role}] ${m.content}`);
    }
    const convo = lines.join('\n\n');
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toTimeString().slice(0, 5);
    const memFile = getMemoryFlushFilePath(date);

    const flushPrompt = buildFlushPrompt({
        memFile,
        time,
        convo,
        ...(multiSessionEnabled ? { sessionId } : {}),
    });

    const flushCli = settings["memory"]?.cli || settings["cli"];
    const flushModel = settings["memory"]?.model || (settings["perCli"]?.[flushCli]?.model) || 'default';

    try {
        const { promise } = _spawnAgent(flushPrompt, {
            agentId: 'memory-flush',
            internal: true,
            forceNew: true,
            _skipInsert: true,
            _skipHistory: true,
            cli: flushCli,
            model: flushModel,
            sysPrompt: loadFlushSysPrompt(),
        });
        promise.then(
            result => completeFlushAttempt({
                result,
                memFile,
                time,
                sessionId,
                multiSessionEnabled,
                maxId,
                ownsGeneration,
                releaseLock,
                clearAttemptTimeout: () => clearTimeout(lockTimeout),
            }),
            error => {
                clearTimeout(lockTimeout);
                if (!ownsGeneration()) return;
                console.error('[memory] flush execution rejected:', error);
                releaseLock();
            },
        ).catch(error => {
            clearTimeout(lockTimeout);
            if (!ownsGeneration()) return;
            console.error('[memory] flush completion failed:', error);
            releaseLock();
        });
        console.log(`[memory] auto-append triggered (${recent.length} msgs → ${flushCli}/${flushModel})`);
    } catch (e) {
        clearTimeout(lockTimeout);
        releaseLock();
        console.error('[memory] flush spawn failed:', e);
    }
}

type CompleteFlushAttemptOptions = {
    result: FlushSpawnResult;
    memFile: string;
    time: string;
    sessionId: string;
    multiSessionEnabled: boolean;
    maxId: number;
    ownsGeneration: () => boolean;
    releaseLock: () => void;
    clearAttemptTimeout: () => void;
};

async function completeFlushAttempt(opts: CompleteFlushAttemptOptions): Promise<void> {
    opts.clearAttemptTimeout();
    if (!opts.ownsGeneration()) return;

    if (opts.result.code !== 0) {
        console.warn(`[memory] flush failed (code=${opts.result.code}); watermark unchanged`);
        opts.releaseLock();
        return;
    }

    const raw = typeof opts.result.text === 'string' ? opts.result.text : '';
    if (Buffer.byteLength(raw, 'utf8') > MAX_FLUSH_OUTPUT_BYTES) {
        console.warn('[memory] flush output exceeded 64 KiB; discarded');
        opts.releaseLock();
        return;
    }

    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'SKIP') {
        if (trimmed === 'SKIP') _lastFlushedMessageId = opts.maxId;
        opts.releaseLock();
        return;
    }

    const summary = trimmed
        .split(/\r?\n/)
        .filter(line => !SESSION_HEADING_RE.test(line))
        .join('\n')
        .trim();
    if (!summary || !opts.ownsGeneration()) {
        opts.releaseLock();
        return;
    }

    const heading = opts.multiSessionEnabled
        ? `## ${opts.time} · session:${opts.sessionId}`
        : `## ${opts.time}`;
    fs.mkdirSync(join(opts.memFile, '..'), { recursive: true });
    if (!opts.ownsGeneration()) return;
    fs.appendFileSync(opts.memFile, `\n${heading}\n\n${summary}\n`);

    if (!opts.ownsGeneration()) return;
    try {
        await maybeAutoReflect();
    } catch (error) {
        console.error('[memory] post-flush auto-reflect failed:', error);
    }
    if (!opts.ownsGeneration()) return;

    await triggerEmbeddingSync();
    if (!opts.ownsGeneration()) return;

    _lastFlushedMessageId = opts.maxId;
    opts.releaseLock();
    console.log(`[memory] flush complete (code=${opts.result.code}), watermark=${opts.maxId}`);
}

async function triggerEmbeddingSync(): Promise<void> {
    try {
        const home = resolveDashboardHome();
        const cfgPath = join(home, 'embedding.json');
        if (!fs.existsSync(cfgPath)) return;
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (!cfg.enabled) return;

        const port = Number(process.env['DASHBOARD_PORT']) || Number(DASHBOARD_DEFAULT_PORT);
        const resp = await fetch(`http://127.0.0.1:${port}/api/dashboard/memory/reindex`, {
            method: 'POST',
            signal: AbortSignal.timeout(30_000),
            headers: { host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        });
        if (resp.ok) {
            console.log('[memory] post-flush embedding sync triggered');
        }
    } catch (err) {
        console.warn('[memory] post-flush embedding sync failed (non-critical):', (err as Error).message);
    }
}

export function getFlushStatus() {
    return {
        locked: _flushLock,
        lastFlushedMessageId: _lastFlushedMessageId,
        counter: memoryFlushCounter,
        cycleCount: flushCycleCount,
    };
}
