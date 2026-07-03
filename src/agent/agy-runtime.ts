import type { SpawnContext, ToolEntry } from '../types/agent.js';
import type { AgyTranscriptMode } from '../types/agent.js';

export const AGY_TIMEOUT_PREFIX = 'Error: timed out waiting for response';
export const AGY_COMPLETE_KILL_REASON = 'agy-complete';
export const AGY_PRINT_QUIET_COMPLETION_MS = 5_000;
export const AGY_FALLBACK_QUIET_COMPLETION_MS = 20_000;
/** Safety bound for agy stdout accumulation. Far above any real answer; replaces the
 * silent 102,400 cap that shortened stdout-fallback final answers. */
export const AGY_FULLTEXT_MAX_CHARS = 8_388_608;
/** Live prefix-diff display freezes past this bound (per-chunk cost guard);
 * accumulation continues to AGY_FULLTEXT_MAX_CHARS and is promoted at close. */
export const AGY_LIVE_DISPLAY_MAX_CHARS = 262_144;
export const AGY_FULLTEXT_TRUNCATION_NOTICE = '\n\n[jaw:agy] stdout capture truncated at 8 MiB safety bound';
const AGY_CONVERSATION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const AGY_CONVERSATION_ID_RE = new RegExp(
    `(?:\\bagy\\s+)?--conversation(?:=|\\s+)(${AGY_CONVERSATION_ID})\\b|\\b(?:conversation=|Created conversation\\s+)(${AGY_CONVERSATION_ID})\\b`,
    'i',
);

export function isAgyTimeoutOutput(text: string): boolean {
    return text.trimStart().startsWith(AGY_TIMEOUT_PREFIX);
}

export function formatAgyTimeoutMessage(text: string): string {
    const trimmed = text.trim();
    return trimmed || AGY_TIMEOUT_PREFIX;
}

export function formatAgyTranscriptErrorMessage(error: NonNullable<SpawnContext['agyLastTranscriptError']>): string {
    const message = String(error.message || 'Antigravity provider error').replace(/\s+/g, ' ').trim();
    const suffix = error.code !== undefined && error.code !== ''
        ? ` (${error.code})`
        : '';
    return `Antigravity backend unavailable${suffix}: ${message || 'Antigravity provider error'}`;
}

export function resolveAgyEmptyCloseError(ctx: Pick<SpawnContext, 'fullText' | 'liveOutputText' | 'agyLastTranscriptError'>): string | null {
    if (!ctx.agyLastTranscriptError) return null;
    const visibleText = String(ctx.liveOutputText || ctx.fullText || '').trim();
    if (visibleText) return null;
    return formatAgyTranscriptErrorMessage(ctx.agyLastTranscriptError);
}

function visibleAgyText(ctx: Pick<SpawnContext, 'fullText' | 'liveOutputText'>): string {
    return String(ctx.liveOutputText || ctx.fullText || '').trim();
}

export function appendAgyFullText(
    ctx: Pick<SpawnContext, 'fullText' | 'agyFullTextTruncated'>,
    text: string,
): void {
    if (ctx.agyFullTextTruncated) return;
    const remaining = AGY_FULLTEXT_MAX_CHARS - ctx.fullText.length;
    if (text.length <= remaining) {
        ctx.fullText += text;
        return;
    }
    ctx.fullText += text.slice(0, Math.max(0, remaining));
    ctx.agyFullTextTruncated = true;
}

/** Freeze live display only after visible output exists — a first oversized chunk must
 * still flow through the display path so outputTextStarted/liveOutputText are set and
 * quiet completion (shouldCompleteAgyPrintRun) stays eligible. */
export function shouldFreezeAgyLiveDisplay(
    ctx: Pick<SpawnContext, 'outputTextStarted' | 'fullText'>,
): boolean {
    return Boolean(ctx.outputTextStarted) && ctx.fullText.length > AGY_LIVE_DISPLAY_MAX_CHARS;
}

/** Close-path finalization for the stdout-fallback path: promote the full cleaned text
 * into the live candidate (the output resolver prefers display candidates over raw
 * fullText, so a frozen short liveOutputText would otherwise mask the full body), then
 * append the explicit truncation notice to both final-text candidates. fullDisplayText
 * is the display-normalized form of ctx.fullText, derived by the caller with the same
 * strip order as the per-chunk display path. Returns true when anything was applied. */
export function finalizeAgyFallbackText(
    ctx: Pick<SpawnContext, 'fullText' | 'liveOutputText' | 'agyFinalPlannerSeen' | 'agyFullTextTruncated'>,
    fullDisplayText: string,
): boolean {
    if (ctx.agyFinalPlannerSeen) return false;
    let applied = false;
    if (ctx.liveOutputText !== undefined && fullDisplayText.length > ctx.liveOutputText.length) {
        ctx.liveOutputText = fullDisplayText;
        applied = true;
    }
    if (ctx.agyFullTextTruncated && ctx.fullText) {
        ctx.fullText += AGY_FULLTEXT_TRUNCATION_NOTICE;
        if (ctx.liveOutputText) ctx.liveOutputText += AGY_FULLTEXT_TRUNCATION_NOTICE;
        applied = true;
    }
    return applied;
}

export function describeAgyFinalSource(
    ctx: Pick<SpawnContext, 'agyFinalPlannerSeen' | 'agyFinalPlannerText' | 'agyFullTextTruncated' | 'fullText'>,
): string {
    const source = ctx.agyFinalPlannerSeen && ctx.agyFinalPlannerText ? 'transcript' : 'stdout-fallback';
    return `[jaw:agy:final] source=${source} chars=${ctx.fullText.length} truncated=${ctx.agyFullTextTruncated ? 1 : 0}`;
}

export type { AgyTranscriptMode };

export function classifyAgyTranscriptMode(ctx: Pick<SpawnContext,
    'agyTranscriptActive' |
    'agyBootstrapAcceptanceMode' |
    'agyLastTranscriptError' |
    'fullText' |
    'liveOutputText'
>): AgyTranscriptMode {
    if (ctx.agyLastTranscriptError) return 'provider-error';
    if (ctx.agyTranscriptActive) {
        if (ctx.agyBootstrapAcceptanceMode === 'missing' || ctx.agyBootstrapAcceptanceMode === 'pending') {
            return 'bootstrap-missing';
        }
        return 'anchored';
    }
    const visibleText = visibleAgyText(ctx);
    if (!visibleText) return 'not-started';
    if (hasAgyTimeoutMarker(visibleText)) return 'fallback-timeout';
    return 'fallback-missing';
}

function sanitizeWatchdogValue(value: unknown, fallback = 'none'): string {
    const sanitized = String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/[\r\n\t]/g, ' ')
        .trim();
    return (sanitized || fallback).slice(0, 160);
}

function sanitizeWatchdogToolLabel(value: unknown): string {
    const label = sanitizeWatchdogValue(value, 'tool');
    if (/\[(?:Current cli-jaw task|Operational Context|Recent context|CLI-JAW AGY BOOTSTRAP)\]/i.test(label)) {
        return 'transcript tool';
    }
    if (/CLI_JAW_BOOTSTRAP_SHA=|USER_REQUEST|SECRET|PROMPT/i.test(label)) {
        return 'transcript tool';
    }
    return label;
}

export function formatAgyWatchdogContext(ctx: Pick<SpawnContext,
    'stallReason' |
    'agyTranscriptMode' |
    'agyTranscriptLastReason' |
    'agyLastActivitySource' |
    'sessionId' |
    'toolLog'
>): string {
    const lastTool = [...(ctx.toolLog || [])].reverse()
        .find((tool) => typeof tool.label === 'string' && tool.label.trim());
    const lines = [
        '[AGY interrupted by watchdog]',
        `reason=${sanitizeWatchdogValue(ctx.stallReason, 'unknown')}`,
        `transcriptMode=${sanitizeWatchdogValue(ctx.agyTranscriptMode, 'not-started')}`,
        `lastActivity=${sanitizeWatchdogValue(ctx.agyLastActivitySource, 'none')}`,
        `sessionId=${sanitizeWatchdogValue(ctx.sessionId, 'none')}`,
    ];
    if (ctx.agyTranscriptLastReason) {
        lines.push(`transcriptReason=${sanitizeWatchdogValue(ctx.agyTranscriptLastReason)}`);
    }
    if (lastTool) {
        lines.push(`lastTool=${sanitizeWatchdogToolLabel(lastTool.label)} status=${sanitizeWatchdogValue(lastTool.status)}`);
    }
    return lines.join('\n');
}

export function stripAgyTrailingTimeoutOutput(text: string): { text: string; stripped: boolean } {
    const idx = text.indexOf(AGY_TIMEOUT_PREFIX);
    if (idx <= 0) return { text, stripped: false };
    const before = text.slice(0, idx).trimEnd();
    if (!before.trim()) return { text, stripped: false };
    return { text: before, stripped: true };
}

export type AgyCloseTextNormalization = {
    text: string;
    liveText: string | undefined;
    timedOut: boolean;
    timeoutMessage: string;
    strippedTimeout: boolean;
};

function hasAgyTimeoutMarker(text: string): boolean {
    return text.includes(AGY_TIMEOUT_PREFIX);
}

export function normalizeAgyCloseText(options: {
    fullText: string;
    liveOutputText?: string | undefined;
    allowTimeoutSuffixStrip: boolean;
}): AgyCloseTextNormalization {
    const fullText = options.fullText;
    const liveText = options.liveOutputText;
    const fullHasTimeout = hasAgyTimeoutMarker(fullText);
    const liveHasTimeout = liveText !== undefined && hasAgyTimeoutMarker(liveText);
    if (!fullHasTimeout && !liveHasTimeout) {
        return { text: fullText, liveText, timedOut: false, timeoutMessage: '', strippedTimeout: false };
    }
    if (options.allowTimeoutSuffixStrip) {
        const strippedFull = stripAgyTrailingTimeoutOutput(fullText);
        const strippedLive = liveText === undefined ? undefined : stripAgyTrailingTimeoutOutput(liveText);
        if (strippedFull.stripped || strippedLive?.stripped) {
            return {
                text: strippedFull.text,
                liveText: strippedLive?.text ?? liveText,
                timedOut: false,
                timeoutMessage: '',
                strippedTimeout: true,
            };
        }
    }
    return {
        text: fullText,
        liveText,
        timedOut: true,
        timeoutMessage: AGY_TIMEOUT_PREFIX,
        strippedTimeout: false,
    };
}

export function stripAgyResumeReplayPrefix(text: string, previousAssistantText: string | null | undefined): { text: string; stripped: boolean } {
    const previous = String(previousAssistantText || '').trim();
    if (!previous) return { text, stripped: false };
    const current = String(text || '');
    if (!current.startsWith(previous)) return { text, stripped: false };
    const rest = current.slice(previous.length).replace(/^\s+/, '');
    if (!rest.trim()) return { text, stripped: false };
    return { text: rest, stripped: true };
}

export function stripAgyResumeReplayPrefixes(text: string, previousAssistantTexts: readonly string[]): { text: string; stripped: boolean; replayOnly: boolean } {
    let current = String(text || '');
    let stripped = false;
    const prefixes = [...previousAssistantTexts]
        .map(value => String(value || '').trim())
        .filter(Boolean);
    for (let pass = 0; pass < prefixes.length + 1; pass++) {
        let changed = false;
        for (const previous of [...prefixes].reverse()) {
            if (!current.startsWith(previous)) continue;
            current = current.slice(previous.length).replace(/^\s+/, '');
            stripped = true;
            changed = true;
        }
        if (!changed) break;
    }
    return { text: current, stripped, replayOnly: stripped && !current.trim() };
}

export function stripAgyPromptEchoPrefix(text: string, prompt: string): { text: string; stripped: boolean; replayOnly: boolean } {
    const current = String(text || '');
    const rawPrompt = String(prompt || '');
    const candidates = [rawPrompt, rawPrompt.trim()]
        .map(value => value.replace(/\r\n/g, '\n'))
        .filter(Boolean);
    const normalizedCurrent = current.replace(/\r\n/g, '\n');
    for (const candidate of candidates) {
        if (!normalizedCurrent.startsWith(candidate)) continue;
        const rest = normalizedCurrent.slice(candidate.length).replace(/^\s+/, '');
        return { text: rest, stripped: true, replayOnly: !rest.trim() };
    }
    return { text: current, stripped: false, replayOnly: false };
}

export function hasRunningAgyTranscriptTool(toolLog: Pick<ToolEntry, 'status' | 'stepRef'>[]): boolean {
    return toolLog.some((tool) => {
        if (!tool.stepRef?.startsWith('agy:transcript:')) return false;
        return tool.status === 'running';
    });
}

export function shouldCompleteAgyPrintRun(ctx: Pick<SpawnContext, 'outputTextStarted' | 'liveOutputText' | 'fullText' | 'toolLog'>): boolean {
    if (!ctx.outputTextStarted) return false;
    const visibleText = String(ctx.liveOutputText || ctx.fullText || '').trim();
    if (!visibleText) return false;
    if (isAgyTimeoutOutput(visibleText)) return false;
    return !hasRunningAgyTranscriptTool(ctx.toolLog);
}

export function getAgyQuietCompletionDelayMs(ctx: Pick<SpawnContext,
    'outputTextStarted' | 'liveOutputText' | 'fullText' | 'toolLog' | 'agyTranscriptActive' | 'agyFinalPlannerSeen'
>): number | null {
    if (!shouldCompleteAgyPrintRun(ctx)) return null;
    if (ctx.agyTranscriptActive) {
        // Transcript anchoring: intermediate planner rows always carry tool_calls, the
        // final answer row never does — complete only once that final row has been seen.
        return ctx.agyFinalPlannerSeen ? AGY_PRINT_QUIET_COMPLETION_MS : null;
    }
    // Transcript never resolved (brain dir missing/unreadable): legacy stdout-quiet
    // completion with a wide window so runs cannot hang on a missing transcript.
    return AGY_FALLBACK_QUIET_COMPLETION_MS;
}

export { resolveAgyConversationIdFromCache, agyTranscriptPathForConversation } from './agy-transcript.js';

export function extractAgyConversationId(text: string): string | null {
    const match = AGY_CONVERSATION_ID_RE.exec(text);
    return match?.[1] ?? match?.[2] ?? null;
}

const AGY_STALE_WARNING_RE = /^Warning:\s*conversation\s+"[^"]*"\s+not found\b/im;

export function isAgyStaleSessionOutput(text: string): boolean {
    return AGY_STALE_WARNING_RE.test(text);
}
