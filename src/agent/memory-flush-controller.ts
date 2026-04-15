// ─── Memory Flush Controller ─────────────────────────
// Extracted from spawn.ts to reduce file size.

import fs from 'fs';
import { join } from 'path';
import { settings, JAW_HOME } from '../core/config.js';
import { getRecentMessages } from '../core/db.js';
import { getMemoryFlushFilePath } from '../memory/runtime.js';
import { maybeAutoReflect } from '../memory/reflect.js';

export let memoryFlushCounter = 0;
export let flushCycleCount = 0;
let _flushLock = false;
let _lastFlushedMessageId: number | null = null;

export function incrementMemoryFlush(): void {
    memoryFlushCounter++;
}

export function resetMemoryFlushCounter(): void {
    memoryFlushCounter = 0;
    flushCycleCount++;
}

// Forward reference to spawnAgent (avoid circular import)
let _spawnAgent: Function;
let _activeProcesses: Map<string, any>;

export function setSpawnRef(fn: Function, procs: Map<string, any>): void {
    _spawnAgent = fn;
    _activeProcesses = procs;
}

// ─── Flush Prompt Builder (3-A) ──────────────────────

const DEFAULT_FLUSH_PROMPT_TEMPLATE = `You are a memory extractor. Summarize the conversation into a short prose paragraph.
Save by APPENDING to: {{memFile}}
Create directories if needed.

Rules:
- Write 1-3 SHORT English sentences capturing decisions, facts, preferences only
- Skip greetings, errors, small talk
- If nothing worth remembering, reply "SKIP" and do NOT write any file
- Format:

## {{time}}

[your 1-3 sentence summary here]

Conversation:
---
{{convo}}`;

export function buildFlushPrompt(vars: { memFile: string; time: string; convo: string }): string {
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

    const threshold = settings.memory?.flushEvery ?? 10;
    const recent = (getRecentMessages.all(settings.workingDir || null, threshold) as any[])
        .filter((m: any) => !_lastFlushedMessageId || m.id > _lastFlushedMessageId)
        .reverse();
    if (recent.length < 4) return;

    _flushLock = true;
    const lockTimeout = setTimeout(() => {
        if (_flushLock) {
            _flushLock = false;
            console.warn('[memory] flush lock auto-released after 5m timeout');
        }
    }, 5 * 60 * 1000);

    const maxId = Math.max(...recent.map((m: any) => m.id));

    const lines = [];
    for (const m of recent) {
        lines.push(`[${m.role}] ${m.content}`);
    }
    const convo = lines.join('\n\n');
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toTimeString().slice(0, 5);
    const memFile = getMemoryFlushFilePath(date);

    const flushPrompt = buildFlushPrompt({ memFile, time, convo });

    fs.mkdirSync(join(memFile, '..'), { recursive: true });

    const flushCli = settings.memory?.cli || settings.cli;
    const flushModel = settings.memory?.model || (settings.perCli?.[flushCli]?.model) || 'default';

    try {
        _spawnAgent(flushPrompt, {
            agentId: 'memory-flush',
            internal: true,
            _skipInsert: true,
            cli: flushCli,
            model: flushModel,
            sysPrompt: loadFlushSysPrompt(),
            lifecycle: {
                onExit: (code: number | null) => {
                    clearTimeout(lockTimeout);
                    _lastFlushedMessageId = maxId;
                    _flushLock = false;
                    maybeAutoReflect().catch(e =>
                        console.error('[memory] post-flush auto-reflect failed:', e)
                    );
                    console.log(`[memory] flush complete (code=${code}), watermark=${maxId}`);
                },
            },
        });
        console.log(`[memory] auto-append triggered (${recent.length} msgs → ${flushCli}/${flushModel})`);
    } catch (e) {
        clearTimeout(lockTimeout);
        _flushLock = false;
        console.error('[memory] flush spawn failed:', e);
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
