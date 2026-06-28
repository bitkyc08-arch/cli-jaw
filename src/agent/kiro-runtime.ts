import os from 'node:os';
import {
    extractKiroSessionIdFromV2Store,
    listKiroConversationIdsForCwd,
    resolveKiroDataPath,
    resolveKiroSessionIdAfterSpawn,
} from './kiro-auth.js';

export { listKiroConversationIdsForCwd, resolveKiroSessionIdAfterSpawn };

const KIRO_SESSION_ID_STDOUT_RE = /Session\s+ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const KIRO_RESPONSE_LINE_RE = /^>\s*(.*)\s*$/;
const KIRO_CREDITS_FOOTER_RE = /^[▸•]\s*Credits:/i;
const KIRO_TRUST_BANNER_RE = /^All tools are now trusted/i;
const KIRO_LEARN_MORE_RE = /^Learn more at https?:\/\//i;
const KIRO_RISK_BANNER_RE = /^Agents can sometimes do unexpected things/i;
const KIRO_USING_TOOL_RE = /\(using tool:\s*([^)]+)\)/i;
const KIRO_TOOL_DONE_RE = /^\s*-\s*Completed in\s+[\d.]+s\s*$/i;
const KIRO_TOOL_SUCCESS_RE = /^[✓✔]\s+/u;
const KIRO_TERMINAL_MODE_RE = /^\?\d+[hl]/;

export function stripKiroAnsi(text: string): string {
    return text.replace(ANSI_RE, '');
}

export function parseKiroAssistantText(text: string): string {
    const clean = stripKiroAnsi(text);
    const lines = clean.split(/\r?\n/);
    const blocks: string[] = [];
    let current: string[] = [];

    const flush = (): void => {
        const joined = current.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (joined) blocks.push(joined);
        current = [];
    };

    const isToolOrMeta = (line: string): boolean =>
        isKiroIgnoredLine(line)
        || KIRO_TOOL_DONE_RE.test(line)
        || KIRO_USING_TOOL_RE.test(line)
        || KIRO_TOOL_SUCCESS_RE.test(line)
        || /^I will run the following command:/i.test(line)
        || /^Reading file:/i.test(line)
        || /^Writing file:/i.test(line);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            // Kiro long answers use blank lines between markdown sections; keep one block.
            if (current.length) current.push('');
            continue;
        }
        if (isToolOrMeta(line)) {
            flush();
            continue;
        }
        const match = KIRO_RESPONSE_LINE_RE.exec(line);
        if (match) {
            flush();
            const lead = (match[1] || '').trim();
            if (lead) current.push(lead);
            continue;
        }
        if (current.length) current.push(line);
    }
    flush();
    return blocks.join('\n\n').trim();
}

function isKiroIgnoredLine(line: string): boolean {
    return KIRO_TRUST_BANNER_RE.test(line)
        || KIRO_RISK_BANNER_RE.test(line)
        || KIRO_LEARN_MORE_RE.test(line)
        || KIRO_CREDITS_FOOTER_RE.test(line)
        || KIRO_TERMINAL_MODE_RE.test(line)
        || isJawRuntimeLine(line);
}

/** Detect jaw_runtime JSON lines that leak into kiro plain-text stdout */
function isJawRuntimeLine(line: string): boolean {
    return line.startsWith('{"type":"jaw_runtime"') || line.includes('"type":"jaw_runtime"');
}

export function extractKiroSessionIdFromStore(
    cwd: string,
    updatedAfterMs = 0,
    homedir = os.homedir(),
): string | null {
    return extractKiroSessionIdFromV2Store(cwd, updatedAfterMs, resolveKiroDataPath(homedir));
}

/** TUI / exit hint lines — headless `--no-interactive` usually omits these. */
export function parseKiroSessionIdFromStdout(text: string): string | null {
    const match = KIRO_SESSION_ID_STDOUT_RE.exec(stripKiroAnsi(text));
    return match?.[1] ?? null;
}

const KIRO_STALE_SESSION_RE = /(?:no saved chat sessions|conversation\s+not found|invalid\s+resume|session\s+not found|unknown\s+session)/i;

export function isKiroStaleSessionOutput(text: string): boolean {
    return KIRO_STALE_SESSION_RE.test(stripKiroAnsi(text));
}

/** Resume succeeded (exit 0) but produced no assistant body — retry fresh with history. */
export function isKiroResumeDegradedOutput(
    outputText: string,
    toolLogLen: number,
    isResume: boolean,
): boolean {
    if (!isResume) return false;
    return !outputText.trim() && toolLogLen === 0;
}

export type KiroSessionCaptureSource = 'resume-carry' | 'stderr' | 'diff' | 'store' | 'stdout';

export function captureKiroSessionIdAfterExit(args: {
    cwd: string;
    spawnStartedAt: number;
    beforeIds: ReadonlySet<string> | null;
    stdout: string;
    stderr: string;
    resumeSessionId?: string | null;
    isResume: boolean;
}): { id: string | null; source: KiroSessionCaptureSource | null } {
    if (args.isResume && args.resumeSessionId?.trim()) {
        return { id: args.resumeSessionId.trim(), source: 'resume-carry' };
    }

    const fromStderr = parseAiESessionIdFromStderr(args.stderr);
    if (fromStderr) return { id: fromStderr, source: 'stderr' };

    if (args.beforeIds) {
        const fromDiff = resolveKiroSessionIdAfterSpawn(args.cwd, args.beforeIds, args.spawnStartedAt);
        if (fromDiff) return { id: fromDiff, source: 'diff' };
    }

    const fromStore = extractKiroSessionIdFromStore(args.cwd, args.spawnStartedAt);
    if (fromStore) return { id: fromStore, source: 'store' };

    const fromStdout = parseKiroSessionIdFromStdout(args.stdout);
    if (fromStdout) return { id: fromStdout, source: 'stdout' };

    return { id: null, source: null };
}

export function parseAiESessionIdFromStderr(text: string): string | null {
    for (const line of text.split(/\r?\n/)) {
        // Match UUID format (grok, kiro) or codex timestamp-uuid format
        const match = /\[ai-e\]\s+session:\s*(\S+)/i.exec(line);
        if (match?.[1]) return match[1];
    }
    return null;
}

export function isKiroPlainTextCli(cli: string, effectiveProvider?: string | null): boolean {
    return cli === 'kiro-code' || (cli === 'ai-e' && effectiveProvider === 'kiro');
}

export type KiroStreamEvent =
    | { kind: 'assistant_delta'; text: string }
    | {
        kind: 'tool';
        icon: string;
        label: string;
        detail?: string;
        stepRef: string;
        status: 'running' | 'done';
    };

export interface KiroStdoutContext {
    fullText: string;
    kiroDisplayedText?: string;
    kiroLineBuffer?: string;
    kiroToolSeq?: number;
    kiroActiveToolRef?: string | null;
    kiroActiveToolLabel?: string | null;
    kiroAssistantOpen?: boolean;
}

function nextKiroToolRef(ctx: KiroStdoutContext): string {
    ctx.kiroToolSeq = (ctx.kiroToolSeq ?? 0) + 1;
    return `kiro:tool:${ctx.kiroToolSeq}`;
}

function kiroToolIcon(toolName: string): string {
    const normalized = toolName.trim().toLowerCase();
    if (normalized.includes('shell') || normalized.includes('bash') || normalized.includes('cmd')) return '💻';
    if (normalized.includes('read') || normalized.includes('grep') || normalized.includes('glob')) return '📖';
    if (normalized.includes('write') || normalized.includes('edit') || normalized.includes('patch')) return '✏️';
    if (normalized.includes('search') || normalized.includes('web')) return '🔍';
    return '🔧';
}

function formatKiroToolLabel(line: string, toolName: string): string {
    const commandMatch = /^I will run the following command:\s*(.+?)(?:\s*\(using tool:|$)/i.exec(line);
    if (commandMatch?.[1]) {
        const command = commandMatch[1].trim();
        return `${toolName}: ${command.length > 72 ? `${command.slice(0, 69)}...` : command}`;
    }
    const readingMatch = /^Reading file:\s*(.+?)(?:,|\s*\(using tool:|$)/i.exec(line);
    if (readingMatch?.[1]) {
        const path = readingMatch[1].trim();
        return `${toolName}: ${path}`;
    }
    const writingMatch = /^Writing file:\s*(.+?)(?:,|\s*\(using tool:|$)/i.exec(line);
    if (writingMatch?.[1]) {
        const path = writingMatch[1].trim();
        return `${toolName}: ${path}`;
    }
    const compact = line.replace(/\s*\(using tool:[^)]+\)\s*$/i, '').trim();
    return compact ? `${toolName}: ${compact}` : toolName;
}

function syntheticKiroAssistantText(ctx: KiroStdoutContext, extraLine = ''): string {
    const bufferLine = stripKiroAnsi(extraLine || ctx.kiroLineBuffer || '').trim();
    if (!bufferLine) return parseKiroAssistantText(ctx.fullText);
    const needsSep = ctx.fullText.length > 0 && !ctx.fullText.endsWith('\n');
    return parseKiroAssistantText(`${ctx.fullText}${needsSep ? '\n' : ''}${bufferLine}`);
}

function maybePartialKiroAssistant(ctx: KiroStdoutContext): KiroStreamEvent[] {
    const bufferLine = stripKiroAnsi(ctx.kiroLineBuffer || '').trimStart();
    if (!bufferLine.startsWith('>')) return [];
    const assistant = syntheticKiroAssistantText(ctx);
    return emitKiroAssistantDelta(ctx, assistant);
}

/** Emit assistant_delta when parsed fullText grows (e.g. continuation lines after `>`). */
function maybeKiroAssistantGrowth(ctx: KiroStdoutContext): KiroStreamEvent[] {
    const assistant = parseKiroAssistantText(ctx.fullText);
    return emitKiroAssistantDelta(ctx, assistant);
}

function emitKiroAssistantDelta(ctx: KiroStdoutContext, assistant: string): KiroStreamEvent[] {
    const previous = ctx.kiroDisplayedText || '';
    if (!assistant || assistant.length <= previous.length) return [];
    const delta = assistant.slice(previous.length);
    ctx.kiroDisplayedText = assistant;
    return delta ? [{ kind: 'assistant_delta', text: delta }] : [];
}

/** Split parallel tool starts that Kiro prints on one physical line. */
function splitKiroCompositeLine(line: string): string[] {
    if (!KIRO_USING_TOOL_RE.test(line)) return [line];
    const segments: string[] = [];
    const re = /((?:Reading file:|Writing file:|I will run the following command:)[\s\S]*?\(using tool:\s*[^)]+\))/gi;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    while ((match = re.exec(line)) !== null) {
        const segment = match[1]?.trim();
        if (segment) segments.push(segment);
        lastIndex = re.lastIndex;
    }
    const tail = line.slice(lastIndex).trim();
    if (tail) segments.push(tail);
    return segments.length > 0 ? segments : [line];
}

function appendKiroAssistantLine(ctx: KiroStdoutContext, line: string, maxBytes: number): void {
    const prefix = ctx.fullText.length > 0 && !ctx.fullText.endsWith('\n') ? '\n' : '';
    const addition = `${prefix}${line}\n`;
    if (ctx.fullText.length < maxBytes) {
        ctx.fullText += addition;
    } else if (ctx.fullText.length < maxBytes + 100) {
        ctx.fullText += addition.slice(0, maxBytes - ctx.fullText.length);
    }
}

function isKiroToolOrMetaLine(trimmed: string): boolean {
    return isKiroIgnoredLine(trimmed)
        || KIRO_TOOL_DONE_RE.test(trimmed)
        || KIRO_USING_TOOL_RE.test(trimmed)
        || KIRO_TOOL_SUCCESS_RE.test(trimmed)
        || /^I will run the following command:/i.test(trimmed)
        || /^Reading file:/i.test(trimmed)
        || /^Writing file:/i.test(trimmed);
}

export function flushKiroRemainingAssistantDelta(ctx: KiroStdoutContext): KiroStreamEvent[] {
    const parsed = finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer);
    return emitKiroAssistantDelta(ctx, parsed);
}

function classifyKiroLine(line: string, ctx: KiroStdoutContext): KiroStreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed || isKiroIgnoredLine(trimmed)) return [];

    if (KIRO_TOOL_DONE_RE.test(trimmed)) {
        if (!ctx.kiroActiveToolRef) return [];
        const stepRef = ctx.kiroActiveToolRef;
        const label = ctx.kiroActiveToolLabel || 'tool';
        ctx.kiroActiveToolRef = null;
        ctx.kiroActiveToolLabel = null;
        return [{
            kind: 'tool',
            icon: '✅',
            label,
            stepRef,
            status: 'done',
        }];
    }

    const usingTool = KIRO_USING_TOOL_RE.exec(trimmed);
    if (usingTool?.[1]) {
        const toolName = usingTool[1].trim();
        const stepRef = nextKiroToolRef(ctx);
        ctx.kiroActiveToolRef = stepRef;
        ctx.kiroActiveToolLabel = formatKiroToolLabel(trimmed, toolName);
        return [{
            kind: 'tool',
            icon: kiroToolIcon(toolName),
            label: ctx.kiroActiveToolLabel,
            detail: trimmed,
            stepRef,
            status: 'running',
        }];
    }

    if (KIRO_TOOL_SUCCESS_RE.test(trimmed) && ctx.kiroActiveToolRef) {
        return [{
            kind: 'tool',
            icon: '🔧',
            label: ctx.kiroActiveToolLabel || trimmed,
            detail: trimmed,
            stepRef: ctx.kiroActiveToolRef,
            status: 'running',
        }];
    }

    const responseMatch = KIRO_RESPONSE_LINE_RE.exec(trimmed);
    if (responseMatch) {
        const assistant = parseKiroAssistantText(ctx.fullText);
        return emitKiroAssistantDelta(ctx, assistant);
    }

    return [];
}

export function processKiroStdoutChunk(
    ctx: KiroStdoutContext,
    chunk: string,
    maxBytes = 102_400,
): KiroStreamEvent[] {
    const pending = `${ctx.kiroLineBuffer || ''}${chunk}`;
    const parts = pending.split(/\r?\n/);
    ctx.kiroLineBuffer = parts.pop() ?? '';

    const events: KiroStreamEvent[] = [];
    for (const rawLine of parts) {
        const cleanLine = stripKiroAnsi(rawLine).trimEnd();
        const trimmed = cleanLine.trim();
        if (isJawRuntimeLine(trimmed)) continue;
        if (!trimmed) {
            if (ctx.kiroAssistantOpen && !ctx.kiroActiveToolRef) {
                appendKiroAssistantLine(ctx, '', maxBytes);
            }
            continue;
        }
        for (const segment of splitKiroCompositeLine(cleanLine.trim())) {
            const segmentTrimmed = segment.trim();
            const isResponse = KIRO_RESPONSE_LINE_RE.test(segmentTrimmed);
            const isToolOrMeta = isKiroToolOrMetaLine(segmentTrimmed);
            if (isResponse) {
                ctx.kiroAssistantOpen = true;
                appendKiroAssistantLine(ctx, segmentTrimmed, maxBytes);
            } else if (isToolOrMeta) {
                ctx.kiroAssistantOpen = false;
            } else if (ctx.kiroAssistantOpen && !ctx.kiroActiveToolRef) {
                appendKiroAssistantLine(ctx, segmentTrimmed, maxBytes);
            }
            events.push(...classifyKiroLine(segment, ctx));
        }
        events.push(...maybeKiroAssistantGrowth(ctx));
    }
    events.push(...maybePartialKiroAssistant(ctx));
    return events;
}

export function flushKiroStdoutContext(ctx: KiroStdoutContext): KiroStreamEvent[] {
    const pending = ctx.kiroLineBuffer || '';
    ctx.kiroLineBuffer = '';
    if (!pending.trim()) return flushKiroRemainingAssistantDelta(ctx);
    const events = processKiroStdoutChunk(
        ctx,
        pending.endsWith('\n') || pending.endsWith('\r\n') ? pending : `${pending}\n`,
    );
    events.push(...flushKiroRemainingAssistantDelta(ctx));
    return events;
}

export function appendKiroStdoutChunk(
    ctx: KiroStdoutContext,
    chunk: string,
    maxBytes = 102_400,
): string {
    let delta = '';
    for (const event of processKiroStdoutChunk(ctx, chunk, maxBytes)) {
        if (event.kind === 'assistant_delta') delta += event.text;
    }
    return delta;
}

export function finalizeKiroFullText(fullText: string, lineBuffer = ''): string {
    const bufferLine = stripKiroAnsi(lineBuffer).trim();
    const synthetic = bufferLine
        ? `${fullText}${fullText.length > 0 && !fullText.endsWith('\n') ? '\n' : ''}${bufferLine}`
        : fullText;
    return parseKiroAssistantText(synthetic) || parseKiroAssistantText(stripKiroAnsi(synthetic));
}
