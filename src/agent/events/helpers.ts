// Cross-adapter shared utilities used by 2+ event adapter modules.

import { broadcast } from '../../core/bus.js';
import { appendBoundedFullText } from './fulltext-bound.js';
import {
    asCliEventArray,
    asCliEventRecord,
    fieldNumber,
    fieldString,
    isCliEventRecord,
} from '../../types/cli-events.js';
import type { CliEventRecord } from '../../types/cli-events.js';
import type { SpawnContext, ToolEntry } from '../../types/agent.js';
import { finalizeKiroFullText } from '../kiro-runtime.js';
import { replaceLiveRunTools, appendLiveRunTool } from '../live-run-state.js';
import { stampTraceToolEntries } from '../../trace/store.js';
import { updateWorkerTools } from '../../orchestrator/worker-registry.js';
import { sanitizeWorkerProgressTools } from '../../orchestrator/worker-progress.js';

// ─── Core utilities (used by ALL adapters) ───────────

export function liveScopeOf(ctx: SpawnContext): string | null {
    return ctx.liveScope ?? null;
}

export function syncLiveTools(ctx: SpawnContext): void {
    stampTraceToolEntries(ctx);
    // Capture the unsynced tail BEFORE replaceLiveRunTools splices the durable
    // sanitize back into ctx.toolLog: once the entry cap engages, the splice pins
    // the array length at the cap, so an after-splice slice(synced) is empty on
    // every pass and the parent mirror freezes past the cap (doc 86 §4 follow-up).
    const synced = ctx._parentSyncedCount || 0;
    const newTools = ctx.parentLiveScope ? ctx.toolLog.slice(synced) : [];
    const scope = liveScopeOf(ctx);
    if (scope) replaceLiveRunTools(scope, ctx.toolLog);
    if (ctx.parentLiveScope) {
        const parentTools = sanitizeWorkerProgressTools(newTools);
        for (const tool of parentTools) {
            appendLiveRunTool(ctx.parentLiveScope, { ...tool, isEmployee: true });
        }
        // Post-splice length: appends land at the tail and the sanitizer only
        // drops from the head, so the next unsynced run starts exactly here.
        ctx._parentSyncedCount = ctx.toolLog.length;
    }
}

export function emitAgentTool(
    ctx: SpawnContext,
    agentLabel: string | undefined,
    tool: object,
    empTag: Record<string, unknown>,
): void {
    // Legacy parser entries are already accepted ToolEntry projections. Keep this
    // observation separate from their unchanged messaging/progress payload.
    const entry = tool as Partial<ToolEntry>;
    if (typeof entry.icon === 'string' && typeof entry.label === 'string' && typeof entry.toolType === 'string'
        && entry.toolType !== 'thinking' && entry.icon !== '💭' && entry.icon !== '💬') {
        ctx.printActivity?.tool({ ...entry, icon: entry.icon, label: entry.label, toolType: entry.toolType });
    }
    const payload = {
        agentId: agentLabel,
        ...tool,
        ...empTag,
        ...(ctx.traceRunId ? { traceRunId: ctx.traceRunId } : {}),
        ...(ctx.activityIdentity ?? {}),
        startedAt: ctx.runStartedAt,
        // Who this event belongs to. A subscriber that cannot answer that question
        // has to take every agent_tool on the bus, which is how one channel's
        // command lines ended up in another channel's progress message (#398).
        // Stamped here rather than left to bus.ts: that stamp needs multi-session
        // ON and a live ALS frame, and a child's stdout callback guarantees neither.
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        ...(ctx.origin ? { origin: ctx.origin } : {}),
    };
    if (agentLabel && empTag["isEmployee"] === true) {
        updateWorkerTools(agentLabel, ctx.toolLog);
    }
    broadcast(
        'agent_tool',
        payload,
        ctx.traceAudience === 'internal' ? 'internal' : 'public',
    );
}

// Within-run debug log. Long runs (opencode idle pings, unknown-event spam)
// accumulated tens of MB before release at run end — keep the newest tail
// (260613 05 finding 1).
const MAX_TRACE_LOG_LINES = 2000;

export function pushTrace(ctx: SpawnContext | null | undefined, line: string) {
    if (!ctx?.traceLog || !line) return;
    ctx.traceLog.push(line);
    if (ctx.traceLog.length > MAX_TRACE_LOG_LINES) {
        ctx.traceLog.splice(0, ctx.traceLog.length - MAX_TRACE_LOG_LINES);
    }
}

export function logLine(line: string, ctx: SpawnContext | null | undefined) {
    console.log(line);
    pushTrace(ctx, line);
}

// ─── Text formatting ─────────────────────────────────

export function toSingleLine(text: unknown) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

export function clipText(text: string, max: number) {
    if (!max || max < 1) return text;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildPreview(text: unknown, max = 80) {
    return clipText(toSingleLine(text), max);
}

export function appendDetail(...parts: Array<string | null | undefined>): string {
    return parts.map(p => String(p || '').trim()).filter(Boolean).join('\n');
}

export function normalizeAssistantDisplayText(text: unknown): string {
    return String(text || '')
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\n');
}

export function formatJsonDetail(label: string, value: unknown): string {
    if (value == null) return '';
    try {
        return `${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`;
    } catch {
        return `${label}: ${String(value)}`;
    }
}

// ─── Assistant text segment helpers ──────────────────

function assistantStreamText(ctx: SpawnContext): string {
    return ctx.liveOutputText ?? ctx.fullText;
}

function appendAssistantStreamText(ctx: SpawnContext, segment: string): void {
    if (ctx.liveOutputText !== undefined) {
        // liveOutputText is promoted into fullText at close (spawn.ts picks the
        // longest of the candidates), so leaving it unbounded would just move
        // the same 50MB spike under a different field name.
        const live = appendBoundedFullText(ctx.liveOutputText, segment);
        ctx.liveOutputText = live.text;
        if (live.truncated) ctx.fullTextTruncated = true;
        return;
    }
    // D3: bound the accumulator. This is the choke point most CLIs flow
    // through, so capping here covers them in one place.
    const next = appendBoundedFullText(ctx.fullText, segment);
    ctx.fullText = next.text;
    if (next.truncated) ctx.fullTextTruncated = true;
}

export function formatAssistantTextSegment(ctx: SpawnContext, text: unknown): string {
    const raw = normalizeAssistantDisplayText(text);
    if (!raw) return '';
    const streamText = assistantStreamText(ctx);
    if (!ctx.outputTextStarted) {
        ctx.outputTextStarted = true;
        return raw;
    }
    if (/\s$/.test(streamText) || /^\s/.test(raw) || /^[,.;:!?)]/.test(raw) || /^-\S/.test(raw)) return raw;
    return raw.startsWith('- ') || raw.startsWith('* ')
        ? `\n${raw}`
        : `\n- ${raw}`;
}

/** First visible assistant line after tools when the formatted stream is still empty. */
export function formatPostToolAssistantLead(text: unknown): string {
    const raw = String(text || '');
    if (!raw) return '';
    return raw.startsWith('- ') || raw.startsWith('* ') ? raw : `- ${raw}`;
}

export function appendPostToolAssistantLead(ctx: SpawnContext, text: unknown): string {
    const segment = formatPostToolAssistantLead(text);
    if (!segment) return '';
    if (!ctx.outputTextStarted) ctx.outputTextStarted = true;
    appendAssistantStreamText(ctx, segment);
    return segment;
}

export function appendAssistantTextSegment(ctx: SpawnContext, text: unknown): string {
    const segment = formatAssistantTextSegment(ctx, text);
    if (!segment) return '';
    appendAssistantStreamText(ctx, segment);
    return segment;
}

/** Append raw assistant text with NO segment/bullet formatting — for token-granular
 *  streams (plain `claude` text_delta). formatAssistantTextSegment() injects "\n- "
 *  bullets between unjoined segments, which would corrupt mid-token deltas
 *  ("Hel"+"lo" → "Hel\n- lo"), so those bypass it and accumulate raw. Mirrors how the
 *  claude-e snapshot path raw-appends fullText (claude.ts) rather than re-formatting. */
export function appendAssistantRawText(ctx: SpawnContext, text: string): string {
    if (!text) return '';
    if (!ctx.outputTextStarted) ctx.outputTextStarted = true;
    appendAssistantStreamText(ctx, text);
    return text;
}

/** Pick the best assistant body for agent_done after plain-text / segmented CLIs. */
export function resolveSpawnOutputText(ctx: {
    fullText: string;
    liveOutputText?: string;
    kiroDisplayedText?: string;
    kiroLineBuffer?: string;
}): string {
    const raw = ctx.fullText.trim();
    const live = normalizeAssistantDisplayText(ctx.liveOutputText || '').trim();
    const displayed = normalizeAssistantDisplayText(ctx.kiroDisplayedText || '').trim();
    const parsedKiro = ctx.kiroDisplayedText !== undefined || ctx.kiroLineBuffer !== undefined
        ? normalizeAssistantDisplayText(finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer)).trim()
        : '';
    const displayCandidates = [displayed, live, parsedKiro].filter(Boolean);
    if (displayCandidates.length) return displayCandidates.sort((a, b) => b.length - a.length)[0] ?? '';
    return normalizeAssistantDisplayText(raw).trim();
}

export function extractAssistantText(event: CliEventRecord): string {
    if (!event.message?.content) return '';
    const parts: string[] = [];
    for (const block of asCliEventArray(event.message.content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        }
    }
    return parts.join('');
}

// ─── Claude cross-module helpers ─────────────────────
// Used by claude.ts, summary.ts, and/or tool-labels.ts

export function buildClaudeThinkingTool(block: CliEventRecord): ToolEntry {
    const text = String(block.thinking || '').trim();
    const signature = typeof block.signature === 'string' ? block.signature : '';
    if (text) {
        return {
            icon: '💭',
            label: buildPreview(text, 80) || 'thinking...',
            toolType: 'thinking',
            detail: text,
        };
    }
    if (signature) {
        return {
            icon: '🔒',
            label: 'encrypted thinking',
            toolType: 'thinking',
            detail: `server-side reasoning, plaintext withheld - signature ${signature.length}B`,
        };
    }
    return {
        icon: '💭',
        label: 'thinking...',
        toolType: 'thinking',
        detail: '',
    };
}

export function summarizeClaudeRateLimitEvent(event: CliEventRecord): string {
    const status = claudeRateLimitStatus(event);
    if (isClaudeRateLimitAllowed(status)) return '';
    const info = claudeRateLimitInfo(event);
    const rateLimitType = fieldString(info["rateLimitType"] || info["rate_limit_type"]);
    const kind = isClaudeRateLimitWarning(status) ? 'warning' : 'wait';
    return rateLimitType
        ? `claude quota ${kind}: ${status || 'rate_limited'} (${rateLimitType})`
        : `claude quota ${kind}: ${status || 'rate_limited'}`;
}

// Claude rate-limit internal helpers (used by summarizeClaudeRateLimitEvent above + claude.ts)
const CLAUDE_RATE_LIMIT_ALLOWED_STATUSES = new Set(['allowed']);
const CLAUDE_RATE_LIMIT_WARNING_STATUSES = new Set(['allowed_warning', 'warning', 'near_limit']);

export function claudeRateLimitInfo(event: CliEventRecord): CliEventRecord {
    return asCliEventRecord(event["rate_limit_info"] || event["rateLimitInfo"]);
}

export function claudeRateLimitStatus(event: CliEventRecord): string {
    return fieldString(claudeRateLimitInfo(event).status || event.status).toLowerCase();
}

export function isClaudeRateLimitAllowed(status: string): boolean {
    return CLAUDE_RATE_LIMIT_ALLOWED_STATUSES.has(status);
}

export function isClaudeRateLimitWarning(status: string): boolean {
    return CLAUDE_RATE_LIMIT_WARNING_STATUSES.has(status);
}

export function claudeRateLimitResetMs(event: CliEventRecord): number {
    const info = claudeRateLimitInfo(event);
    const resetsAt = fieldNumber(info["resetsAt"] || event["resetsAt"]);
    if (!resetsAt) return 0;
    return resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000;
}

export function claudeRateLimitWaitMs(event: CliEventRecord): number {
    const resetMs = claudeRateLimitResetMs(event);
    if (!resetMs) return 0;
    return Math.max(0, resetMs - Date.now() + 60_000);
}

// ─── Summarize tool input (cross-module) ─────────────

export function summarizeToolInput(toolName: string, input: unknown, max = 0): string {
    if (!input) return '';
    if (typeof input !== 'object') return max ? clipText(String(input), max) : String(input);
    const data = asCliEventRecord(input);
    const s = (v: unknown) => (typeof v === 'string' ? v : v != null ? String(v) : '');
    const name = (toolName || '').toLowerCase();
    let result = '';
    if (name.includes('bash') || name.includes('terminal') || name === 'execute_command')
        result = s(data.command || data.cmd);
    else if (name.includes('read') || name === 'read_file' || name === 'view') {
        const fullPath = s(data["path"] || data["file_path"] || data["filename"]);
        result = max ? (fullPath.split('/').pop() || fullPath) : fullPath;
    } else if (name.includes('write') || name.includes('edit') || name === 'create_file') {
        const fullPath = s(data["path"] || data["file_path"]);
        result = max ? (fullPath.split('/').pop() || fullPath) : fullPath;
    } else if (name.includes('search') || name.includes('grep') || name === 'codebase_search')
        result = s(data.query || data["pattern"] || data["search_query"]);
    else if (name.includes('web') || name === 'web_search')
        result = s(data.query);
    if (!result) {
        try { result = JSON.stringify(input); } catch { /* ignore */ }
    }
    return max ? clipText(result, max) : result;
}

// ─── OpenCode cross-module helpers ───────────────────

export function isOpencodeToolFailure(part: CliEventRecord): boolean {
    const exitCode = part?.state?.metadata?.["exit"];
    if (exitCode != null && exitCode !== 0) return true;
    const status = String(part?.state?.status || '').toLowerCase();
    return status === 'error'
        || status === 'failed'
        || status === 'denied'
        || status === 'cancelled';
}

export function cleanOpencodeTaskResult(output: unknown): string {
    const raw = String(output || '').trim();
    if (!raw) return '';
    const match = raw.match(/<task_result>([\s\S]*?)<\/task_result>/);
    return (match?.[1] || raw).trim();
}

export function formatOpenCodeTaskDetail(part: CliEventRecord): string {
    const state = part?.state || {};
    const input = state.input || {};
    const meta = state.metadata || {};
    const modelInfo = asCliEventRecord(meta.model);
    const model = meta.model
        ? [modelInfo["providerID"], modelInfo["modelID"]].filter(Boolean).join('/')
        : '';
    return appendDetail(
        input.prompt ? `prompt: ${clipText(String(input.prompt), 300)}` : '',
        model ? `model: ${model}` : '',
        meta["sessionId"] ? `child_session: ${meta["sessionId"]}` : '',
        cleanOpencodeTaskResult(state.output) ? `result: ${cleanOpencodeTaskResult(state.output)}` : '',
    );
}

// ─── extractText (cross-module: claude, tool-labels, acp) ────

export function extractText(content: unknown) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(isCliEventRecord)
            .filter(c => c.type === 'text')
            .map(c => c.text || '')
            .join('');
    }
    if (isCliEventRecord(content) && content.type === 'text') {
        return content.text || '';
    }
    return '';
}
/**
 * Which runtimes report liveness through parsed stream-json rather than raw
 * output.
 *
 * cursor was missing here, so its turns fell back to the watchdog's "more than
 * ten bytes came out" heuristic — the same signal a progress bar produces. A
 * real 933s turn died with `lastProgress=output x302`: three hundred weak
 * signals and not one structured (#405).
 *
 * Measured, so the claim stays honest: this does NOT change when a turn dies.
 * A cursor stream-json line is over ten characters, so `observe()` already
 * called `markProgress('output')` for it and pushed the deadline by the same
 * `absoluteMs`. What changes is the stall REPORT — `lastProgress=structured`
 * instead of `output xN` — which is the difference between "the runtime was
 * still working and we cut it off" and "bytes were appearing and we could not
 * tell". The 933s turn was genuinely idle for its last 600s; the remedy for
 * that is the deadline itself, which `jaw doctor` now shows how to raise.
 */
export function streamJsonMarksProgress(cli: string, effectiveProvider?: string): boolean {
    return cli === 'cursor'
        || cli === 'grok'
        || (cli === 'ai-e' && effectiveProvider === 'grok');
}
