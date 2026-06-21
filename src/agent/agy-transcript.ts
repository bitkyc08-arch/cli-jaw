import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolEntry } from '../types/agent.js';

export const AGY_ANTIGRAVITY_HOME = path.join(os.homedir(), '.gemini', 'antigravity-cli');
export const AGY_BRAIN_ROOT = path.join(AGY_ANTIGRAVITY_HOME, 'brain');
export const AGY_LAST_CONVERSATIONS = path.join(AGY_ANTIGRAVITY_HOME, 'cache', 'last_conversations.json');

const NON_TOOL_TYPES = new Set([
    'USER_INPUT',
    'CONVERSATION_HISTORY',
    'CHECKPOINT',
    'SYSTEM_MESSAGE',
    'PLANNER_RESPONSE',
]);

const LABEL_MAX = 120;
const DETAIL_MAX = 400;

export function resolveAgyConversationIdFromCache(cwd: string): string | null {
    try {
        if (!fs.existsSync(AGY_LAST_CONVERSATIONS)) return null;
        const map = JSON.parse(fs.readFileSync(AGY_LAST_CONVERSATIONS, 'utf8')) as Record<string, string>;
        // agy records the realpath (e.g. /private/tmp/... on macOS) while callers may
        // pass the symlinked form (/tmp/...) — try both before giving up.
        let id = map[cwd];
        if (!id) {
            try { id = map[fs.realpathSync(cwd)]; }
            catch { /* cwd may not exist anymore */ }
        }
        return typeof id === 'string' && id.length > 0 ? id : null;
    } catch {
        return null;
    }
}

export type AgyTranscriptResolution = {
    ok: boolean;
    conversationId?: string;
    transcriptPath?: string;
    reason?: string;
};

export type AgyTranscriptResolveOptions = {
    brainRoot?: string;
};

export function agyTranscriptPathForConversation(conversationId: string, brainRoot = AGY_BRAIN_ROOT): string {
    return path.join(brainRoot, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

export function resolveAgyTranscriptPath(
    cwd: string,
    sessionId?: string | null,
    options: AgyTranscriptResolveOptions = {},
): AgyTranscriptResolution {
    const conversationId = sessionId || resolveAgyConversationIdFromCache(cwd);
    if (!conversationId) {
        return { ok: false, reason: 'no conversation id (stdout or last_conversations.json)' };
    }
    const transcriptPath = agyTranscriptPathForConversation(conversationId, options.brainRoot);
    if (!fs.existsSync(transcriptPath)) {
        return { ok: false, conversationId, reason: 'transcript.jsonl not found yet' };
    }
    return { ok: true, conversationId, transcriptPath };
}

function promptNeedle(prompt?: string): string {
    return String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Transcript rows are raw JSONL: the prompt appears JSON-escaped (\n, \", \t as two-char
// sequences), so a plain-text needle spanning newlines or containing quotes never matches.
// Canonicalize the escaped text back before comparing.
function canonicalizeTranscriptText(raw: string): string {
    return raw
        .replace(/\\[nrt]/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\s+/g, ' ');
}

export function transcriptContainsPrompt(transcriptPath: string, prompt?: string): boolean {
    const needle = promptNeedle(prompt);
    if (needle.length < 12) return true;
    try {
        const text = canonicalizeTranscriptText(fs.readFileSync(transcriptPath, 'utf8').slice(0, 96_000));
        return text.includes(needle);
    } catch {
        return false;
    }
}

export function resolveRecentAgyTranscriptPath(
    minMtimeMs: number,
    prompt?: string,
    options: AgyTranscriptResolveOptions = {},
): AgyTranscriptResolution {
    try {
        const brainRoot = options.brainRoot ?? AGY_BRAIN_ROOT;
        if (!fs.existsSync(brainRoot)) return { ok: false, reason: 'brain root not found' };
        let best: { conversationId: string; transcriptPath: string; mtimeMs: number } | null = null;
        for (const entry of fs.readdirSync(brainRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const transcriptPath = agyTranscriptPathForConversation(entry.name, brainRoot);
            let stat: fs.Stats;
            try { stat = fs.statSync(transcriptPath); }
            catch { continue; }
            if (stat.mtimeMs < minMtimeMs) continue;
            if (!transcriptContainsPrompt(transcriptPath, prompt)) continue;
            if (!best || stat.mtimeMs > best.mtimeMs) {
                best = { conversationId: entry.name, transcriptPath, mtimeMs: stat.mtimeMs };
            }
        }
        if (!best) return { ok: false, reason: 'no recent transcript.jsonl' };
        return { ok: true, conversationId: best.conversationId, transcriptPath: best.transcriptPath };
    } catch (e) {
        return { ok: false, reason: (e as Error).message };
    }
}

function transcriptIsFreshEnough(transcriptPath: string, minMtimeMs: number): boolean {
    try {
        return fs.statSync(transcriptPath).mtimeMs >= minMtimeMs;
    } catch {
        return false;
    }
}

export function resolveAgyTranscriptPathForCurrentTurn(
    cwd: string,
    sessionId: string | null | undefined,
    minMtimeMs: number,
    prompt?: string,
    options: AgyTranscriptResolveOptions = {},
): AgyTranscriptResolution {
    const saved = resolveAgyTranscriptPath(cwd, sessionId, options);
    if (saved.ok && saved.transcriptPath) {
        const savedCurrent =
            transcriptIsFreshEnough(saved.transcriptPath, minMtimeMs)
            && transcriptContainsPrompt(saved.transcriptPath, prompt);
        if (savedCurrent) return saved;
    }

    const recent = resolveRecentAgyTranscriptPath(minMtimeMs, prompt, options);
    if (recent.ok) return recent;

    if (saved.ok) {
        const waiting: AgyTranscriptResolution = {
            ok: false,
            reason: `saved transcript is not current-turn (${recent.reason ?? 'no recent prompt-matching transcript'})`,
        };
        if (saved.conversationId) waiting.conversationId = saved.conversationId;
        return waiting;
    }
    if (recent.reason || !saved.reason) return recent;
    return { ...recent, reason: saved.reason };
}

function sanitizeSnippet(text: string, max: number): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= max) return oneLine;
    return `${oneLine.slice(0, max - 1)}…`;
}

function stripAgyMeta(raw: string): string {
    const lines = raw.split('\n');
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!.trim();
        if (l.startsWith('Output:')) { start = i + 1; break; }
        if (l.startsWith('Task Description:')) { start = i; break; }
    }
    return lines.slice(start).join('\n').replace(/^\s+/, '');
}

function labelForStep(type: string, content: string): { label: string; detail: string; icon: string; toolType: string } {
    const snippet = sanitizeSnippet(content, DETAIL_MAX);
    switch (type) {
        case 'RUN_COMMAND': {
            const cleaned = stripAgyMeta(content);
            const firstLine = cleaned.split('\n')[0]?.trim() || 'run command';
            return { icon: '🔧', toolType: 'tool', label: sanitizeSnippet(firstLine, LABEL_MAX), detail: sanitizeSnippet(cleaned, DETAIL_MAX) };
        }
        case 'VIEW_FILE':
            return { icon: '📄', toolType: 'tool', label: 'view file', detail: snippet };
        case 'LIST_DIRECTORY':
            return { icon: '📂', toolType: 'tool', label: 'list directory', detail: snippet };
        case 'GREP_SEARCH':
            return { icon: '🔍', toolType: 'search', label: 'grep search', detail: snippet };
        case 'SEARCH_WEB':
            return { icon: '🌐', toolType: 'search', label: 'web search', detail: snippet };
        case 'READ_URL_CONTENT':
            return { icon: '🔗', toolType: 'search', label: 'read url', detail: snippet };
        case 'CODE_ACTION':
            return { icon: '📝', toolType: 'tool', label: sanitizeSnippet(snippet, LABEL_MAX) || 'code action', detail: snippet };
        case 'PLANNER_RESPONSE':
            return { icon: '💭', toolType: 'thinking', label: sanitizeSnippet(snippet, LABEL_MAX) || 'planner', detail: snippet };
        default:
            return { icon: '🔧', toolType: 'tool', label: type.toLowerCase().replace(/_/g, ' '), detail: snippet };
    }
}

export function agyTranscriptStepKey(stepIndex: unknown, type: string, namespace?: string | null): string {
    const base = `${stepIndex ?? 'x'}:${type}`;
    return namespace ? `${namespace}:${base}` : base;
}

export function parseTranscriptLine(line: string): ToolEntry | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let row: Record<string, unknown>;
    try {
        row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
        return null;
    }
    const type = typeof row['type'] === 'string' ? row['type'] : '';
    if (!type || NON_TOOL_TYPES.has(type)) return null;

    let content = typeof row['content'] === 'string' ? row['content'] : '';
    const stepIndex = row['step_index'];
    const statusRaw = typeof row['status'] === 'string' ? row['status'] : '';
    const { icon, label, detail, toolType } = labelForStep(type, content);
    const entry: ToolEntry = {
        icon,
        label,
        detail,
        toolType,
        stepRef: `agy:transcript:${stepIndex}:${type}`,
    };
    if (statusRaw === 'DONE') entry.status = 'done';
    else if (statusRaw) entry.status = 'running';
    return entry;
}

export type AgyTranscriptRowKind = 'tool' | 'final-planner' | 'planner' | 'meta' | 'invalid';

function hasEmptyToolCalls(row: Record<string, unknown>): boolean {
    const toolCalls = row['tool_calls'];
    if (toolCalls === null || toolCalls === undefined || toolCalls === '') return true;
    if (Array.isArray(toolCalls)) return toolCalls.length === 0;
    if (typeof toolCalls === 'object') return Object.keys(toolCalls as object).length === 0;
    return false;
}

export function classifyAgyTranscriptRow(line: string): { kind: AgyTranscriptRowKind; tool?: ToolEntry } {
    const trimmed = line.trim();
    if (!trimmed) return { kind: 'invalid' };
    let row: Record<string, unknown>;
    try {
        row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
        return { kind: 'invalid' };
    }
    const type = typeof row['type'] === 'string' ? row['type'] : '';
    if (!type) return { kind: 'invalid' };
    if (type === 'PLANNER_RESPONSE') {
        const content = typeof row['content'] === 'string' ? row['content'].trim() : '';
        return { kind: content && hasEmptyToolCalls(row) ? 'final-planner' : 'planner' };
    }
    if (NON_TOOL_TYPES.has(type)) return { kind: 'meta' };
    const tool = parseTranscriptLine(trimmed);
    return tool ? { kind: 'tool', tool } : { kind: 'tool' };
}

export function readTranscriptDelta(transcriptPath: string, offset: number): { offset: number; lines: string[] } {
    const stat = fs.statSync(transcriptPath);
    if (stat.size <= offset) return { offset, lines: [] };
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
        fs.readSync(fd, buf, 0, len, offset);
    } finally {
        fs.closeSync(fd);
    }
    const chunk = buf.toString('utf8');
    const atEof = offset + len >= stat.size;
    const parts = chunk.split('\n');
    const completeLines: string[] = [];
    let remainder = '';
    if (!chunk.endsWith('\n') && parts.length > 0) {
        remainder = parts[parts.length - 1] ?? '';
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i] ?? '';
            if (part.trim()) completeLines.push(part);
        }
        if (atEof && remainder.trim()) completeLines.push(remainder);
        remainder = atEof ? '' : remainder;
    } else {
        for (const p of parts) {
            if (p.trim()) completeLines.push(p);
        }
    }
    const newOffset = stat.size - Buffer.byteLength(remainder, 'utf8');
    return { offset: newOffset, lines: completeLines };
}
