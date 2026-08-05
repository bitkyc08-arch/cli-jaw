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
// Per session, because the rows being filtered are per session. A single watermark
// meant the highest id any session had flushed became the floor for every other one:
// a quiet session with older unflushed rows could never summarise them again, since
// they all sat below a mark that a busier session had already pushed past (073 §2.3).
const _lastFlushedMessageId = new Map<string, number>();
// Sessions whose flush was turned away because another session held the writer lock.
// The lock stays global on purpose — every session appends to one memory file, and
// letting two writers in would corrupt it rather than isolate them. But a turned-away
// flush used to just vanish, and the trigger counter had already been reset by the
// caller, so nothing brought that session back. A session that only ever reached the
// threshold while a busier one held the lock would never be summarised (073 §2.3a).
const _deferredFlushSessions = new Set<string>();
// A drain runs from inside a lock release, and the flush it starts can release the lock
// again before the loop finishes — re-entering here and processing the same queue twice.
let _drainInProgress = false;
// A session that never comes back would otherwise sit in the set forever. The bound is
// generous because the real ceiling is how many sessions exist, and dropping the oldest
// costs one deferred summary rather than unbounded memory.
const MAX_DEFERRED_FLUSH_SESSIONS = 256;
let _flushGeneration = 0;
let _activeFlushGeneration: number | null = null;

const FLUSH_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FLUSH_OUTPUT_BYTES = 64 * 1024;
/**
 * Matches any line the indexer would treat as a structural heading.
 *
 * The indexer parses `/^(#{1,3})\s+(.+)$/` against `line.trim()`
 * (indexing.ts:97), so leading whitespace does not protect us. Two distinct
 * attacks exist and both must be closed:
 *
 *  - a forged H2 carrying ` · session:<id>` becomes fabricated provenance;
 *  - a PLAIN H1 (say `# Decisions`) resets the heading stack, so every chunk
 *    after it loses the canonical H2 session heading entirely — erasing
 *    provenance without forging anything.
 *
 * Extractor output is untrusted prose, so no heading in it is legitimate.
 * Neutralize them all rather than pattern-matching the session marker.
 */
const UNTRUSTED_HEADING_RE = /^\s*#{1,6}\s+/;

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
    permissions: string;
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

export function buildFlushPrompt(vars: { memFile?: string; time: string; convo: string; sessionId?: string }): string {
    const customPath = join(JAW_HOME, 'prompts', 'flush-prompt.md');
    let template = DEFAULT_FLUSH_PROMPT_TEMPLATE;
    if (fs.existsSync(customPath)) {
        try {
            template = fs.readFileSync(customPath, 'utf8');
        } catch (err) {
            console.warn(`[memory] failed to load custom flush prompt: ${(err as Error).message}`);
        }
    }
    // memFile is intentionally NOT exposed. The extractor returns text; cli-jaw
    // owns the append. Handing it the destination path would let a custom
    // template — or hostile conversation text — steer a direct write that
    // bypasses output validation, generation ownership, and the canonical
    // heading. Legacy templates referencing {{memFile}} keep the literal token,
    // which is inert, rather than resolving to a writable path.
    const safeVars: Record<string, string> = { time: vars.time, convo: vars.convo };
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
    return triggerMemoryFlushForSession(null);
}

// Draining stops at the first session that actually takes the lock, because that one now
// owns the writer and its own release will come back here for the rest. It cannot stop at
// the first session it merely TRIES: a session whose rows were deleted, or that has since
// fallen under the threshold, does nothing and frees no lock, so the queue behind it would
// sit until some unrelated flush happened to release. The set is insertion-ordered, so
// each pass continues where the last one stopped.
function drainDeferredFlushes(): void {
    if (_drainInProgress) return;
    _drainInProgress = true;
    try {
        while (!_flushLock) {
            const next = _deferredFlushSessions.values().next();
            if (next.done) return;
            _deferredFlushSessions.delete(next.value);
            // Detached on purpose: this runs from inside a lock release, and awaiting the
            // whole flush there would hold the releasing attempt's frame open for it. The
            // part that decides whether the lock is taken runs synchronously before the
            // first await, so the loop condition above sees the result.
            void triggerMemoryFlushForSession(next.value).catch(error => {
                console.warn('[memory] deferred flush failed:', (error as Error).message);
            });
        }
    } finally {
        _drainInProgress = false;
    }
}

async function triggerMemoryFlushForSession(deferredSessionId: string | null): Promise<void> {
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    // A deferred flush names its session outright: by the time it runs, the async-local
    // context of the turn that asked for it is long gone.
    const sessionId = deferredSessionId
        ?? (multiSessionEnabled
            ? (currentSessionScope()?.chatSessionId ?? getActiveChatSession())
            : getActiveChatSession());

    if (_flushLock) {
        _deferredFlushSessions.add(sessionId);
        if (_deferredFlushSessions.size > MAX_DEFERRED_FLUSH_SESSIONS) {
            const oldest = _deferredFlushSessions.values().next();
            if (!oldest.done) {
                _deferredFlushSessions.delete(oldest.value);
                console.warn(`[memory] deferred flush queue full; dropped session=${oldest.value}`);
            }
        }
        console.log(`[memory] flush lock held; deferring session=${sessionId}`);
        return;
    }
    _deferredFlushSessions.delete(sessionId);

    const threshold = settings["memory"]?.flushEvery ?? 10;
    const recent = (getRecentMessages.all(settings["workingDir"] || null, sessionId, threshold) as any[])
        .filter((m: any) => {
            const mark = _lastFlushedMessageId.get(sessionId);
            return mark === undefined || m.id > mark;
        })
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
            drainDeferredFlushes();
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
            // The extractor is an output-only summarizer. cli-jaw owns the
            // append, so denying the permission bypass keeps a hostile
            // conversation from talking it into writing the memory file
            // directly and sidestepping validation entirely. The prompt's
            // "do not write" line is guidance, not a boundary.
            permissions: 'deny',
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
        if (trimmed === 'SKIP') _lastFlushedMessageId.set(opts.sessionId, opts.maxId);
        opts.releaseLock();
        return;
    }

    const summary = trimmed
        .split(/\r?\n/)
        // Neutralize rather than drop: removing the line would silently delete
        // content, while escaping keeps the text and only strips its structural
        // power over the indexer's heading stack.
        .map(line => (UNTRUSTED_HEADING_RE.test(line) ? line.replace(/^(\s*)#/, '$1\\#') : line))
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

    // Reindex the file we just wrote, inside generation ownership. This used to
    // be fire-and-forget from lifecycle-handler's onExit, which ran before the
    // extractor promise resolved — so it reindexed a file that did not yet
    // contain this entry, and an expired attempt could still trigger it.
    if (!opts.ownsGeneration()) return;
    try {
        const { reindexIntegratedMemoryFile } = await import('../memory/indexing.js');
        reindexIntegratedMemoryFile(opts.memFile);
    } catch (error) {
        console.warn('[memory:flush] post-flush reindex failed:', (error as Error).message);
    }

    if (!opts.ownsGeneration()) return;
    try {
        await maybeAutoReflect();
    } catch (error) {
        console.error('[memory] post-flush auto-reflect failed:', error);
    }
    if (!opts.ownsGeneration()) return;

    await triggerEmbeddingSync();
    if (!opts.ownsGeneration()) return;

    _lastFlushedMessageId.set(opts.sessionId, opts.maxId);
    opts.releaseLock();
    console.log(`[memory] flush complete (code=${opts.result.code}), watermark=${opts.maxId} session=${opts.sessionId}`);
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
        // Kept as a single number for callers that predate multi-session, reporting the
        // furthest any session has reached, plus the per-session marks behind it.
        lastFlushedMessageId: _lastFlushedMessageId.size === 0
            ? null
            : Math.max(..._lastFlushedMessageId.values()),
        lastFlushedMessageIdBySession: Object.fromEntries(_lastFlushedMessageId),
        deferredFlushSessions: [..._deferredFlushSessions],
        counter: memoryFlushCounter,
        cycleCount: flushCycleCount,
    };
}
