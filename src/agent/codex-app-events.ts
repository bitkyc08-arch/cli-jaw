// ─── Codex AppServer Event Normalizer ────────────────
// Maps app-server JSON-RPC notifications to the same
// { tool, text, sessionId, tokens } shape spawn.ts expects.

import { stripUndefined } from '../core/strip-undefined.js';
import type { SpawnContext, ToolEntry } from '../types/agent.js';
import type {
    CodexAppClient,
    CodexAppNotificationOwner,
    CodexAppUnroutedNotification,
} from './codex-app-client.js';

type EvRec = Record<string, unknown>;

export interface CodexAppEventResult {
    tool?: ToolEntry | undefined;
    text?: string | undefined;
    channel?: string | undefined;
    /** Wire id of the agentMessage this event belongs to (item/started + delta). */
    itemId?: string | undefined;
    /** True on item/started for an agentMessage: a NEW durable message begins here. */
    messageStarted?: boolean | undefined;
    sessionId?: string | undefined;
    tokens?: Record<string, number> | undefined;
    flushThinking?: boolean | undefined;
    turnStatus?: string | undefined;
}

export interface CodexAppTurnLeaseIdentity {
    readonly threadId: string;
}

export interface CodexAppTurnAdapterHandlers {
    onProgress(): void;
    onRawNotification(method: string, params: EvRec): void;
    onDiagnosticNotification?(entry: CodexAppUnroutedNotification): void;
    onEvent(method: string, result: CodexAppEventResult | null): void;
    onStderr(text: string): void;
    onExit?(code: number | null, signal: string | null): void;
    onError?(err: Error): void;
    onInterruptFailed?(err: Error): void;
}

export function listenCodexAppTurnAdapter(
    client: CodexAppClient,
    lease: CodexAppTurnLeaseIdentity | null,
    laneScope: string,
    ctx: SpawnContext,
    handlers: CodexAppTurnAdapterHandlers,
): { dispose(): void } {
    const onRawOnlyNotification = (method: string, params: EvRec) => {
        handlers.onProgress();
        handlers.onRawNotification(method, params);
    };
    const onNotification = (
        method: string,
        params: EvRec,
        owner?: CodexAppNotificationOwner,
    ) => {
        onRawOnlyNotification(method, params);
        const expectedThreadId = lease?.threadId ?? client.getThreadId(laneScope);
        const expectedTurnId = client.getActiveTurnId(laneScope);
        if (
            !expectedThreadId
            || !expectedTurnId
            || !owner
            || owner.threadId !== expectedThreadId
            || owner.turnId !== expectedTurnId
        ) return;
        handlers.onEvent(method, extractFromCodexAppLaneEvent(
            method,
            params,
            ctx,
            expectedThreadId,
            expectedTurnId,
        ));
    };
    const turnHandlers = {
        onNotification,
        onStderr: handlers.onStderr,
        onExit: (code: number | null, signal: string | null) => { handlers.onExit?.(code, signal); },
        onError: (err: Error) => { handlers.onError?.(err); },
        onInterruptFailed: (err: Error) => { handlers.onInterruptFailed?.(err); },
    };
    const laneListener = client.listenTurn(laneScope, { ...turnHandlers, role: 'consumer' });
    const onDiagnosticNotification = (entry: CodexAppUnroutedNotification) => {
        handlers.onDiagnosticNotification?.(entry);
    };
    client.on('unrouted-notification', onDiagnosticNotification);
    let hostListener: { dispose(): void };
    try {
        hostListener = client.listenHostNotifications({ onNotification: onRawOnlyNotification });
    } catch (err) {
        client.off('unrouted-notification', onDiagnosticNotification);
        laneListener.dispose();
        throw err;
    }

    let disposed = false;
    return {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            laneListener.dispose();
            hostListener.dispose();
            client.off('unrouted-notification', onDiagnosticNotification);
        },
    };
}

function f(obj: EvRec, key: string): unknown { return obj[key]; }
function fs(obj: EvRec, key: string): string { return String(obj[key] ?? ''); }

export function readCodexAppThreadId(params: EvRec): string | undefined {
    const direct = fs(params, 'threadId');
    if (direct) return direct;
    const thread = f(params, 'thread') as EvRec | undefined;
    return thread ? (fs(thread, 'id') || undefined) : undefined;
}

export function readCodexAppTurnId(params: EvRec): string | undefined {
    const direct = fs(params, 'turnId');
    if (direct) return direct;
    const turn = f(params, 'turn') as EvRec | undefined;
    return turn ? (fs(turn, 'id') || undefined) : undefined;
}

export function extractFromCodexAppLaneEvent(
    method: string,
    params: EvRec,
    ctx: SpawnContext,
    expectedThreadId: string,
    expectedTurnId: string,
): CodexAppEventResult | null {
    const wireThreadId = readCodexAppThreadId(params);
    const wireTurnId = readCodexAppTurnId(params);
    if (wireThreadId !== expectedThreadId || wireTurnId !== expectedTurnId) return null;
    return normalizeCodexAppEvent(method, params, ctx);
}

function normalizeCodexAppEvent(
    method: string,
    params: EvRec,
    ctx: SpawnContext,
): CodexAppEventResult | null {
    switch (method) {
        case 'turn/started':
            return handleTurnStarted(params, ctx);
        case 'item/started':
            return handleItemStarted(params);
        case 'item/agentMessage/delta':
            return handleAgentMessageDelta(params);
        case 'item/completed':
            return handleItemCompleted(params, ctx);
        case 'thread/tokenUsage/updated':
            return handleTokenUsageUpdated(params, ctx);
        case 'item/reasoning/summaryTextDelta':
            return handleReasoningDelta(params);
        case 'item/reasoning/textDelta':
            return handleReasoningDelta(params);
        case 'item/reasoning/summaryPartAdded':
            return handleReasoningSummaryPartAdded(params);
        case 'turn/completed': {
            const turn = f(params, 'turn') as EvRec | undefined;
            const status = turn ? fs(turn, 'status') : 'completed';
            return { flushThinking: true, turnStatus: status || 'completed' };
        }
        case 'error':
            return handleError(params);
        default:
            return null;
    }
}

function handleTurnStarted(params: EvRec, ctx: SpawnContext): CodexAppEventResult {
    const threadId = fs(params, 'threadId') || undefined;
    if (threadId) ctx.sessionId = threadId;
    return threadId ? { sessionId: threadId } : {};
}

function handleItemStarted(params: EvRec): CodexAppEventResult | null {
    const item = f(params, 'item') as EvRec | undefined;
    if (!item) return null;

    const type = fs(item, 'type');
    const id = fs(item, 'id');

    switch (type) {
        case 'commandExecution': {
            const command = fs(item, 'command') || 'exec';
            return {
                tool: {
                    icon: '⚡',
                    label: command.length > 120 ? command.slice(0, 119) + '…' : command,
                    toolType: 'command' as const,
                    detail: command,
                    stepRef: `codex-app:item:${id}`,
                    status: 'running',
                },
            };
        }
        case 'fileChange': {
            const changes = f(item, 'changes') as Array<EvRec> | undefined;
            const firstFile = changes?.[0] ? (fs(changes[0], 'path') || fs(changes[0], 'file') || 'file') : 'file';
            const count = changes?.length || 1;
            const label = count > 1 ? `${count} file changes (${firstFile}, ...)` : `edit ${firstFile}`;
            return {
                tool: {
                    icon: '✏️',
                    label,
                    toolType: 'file' as const,
                    detail: String(firstFile),
                    stepRef: `codex-app:item:${id}`,
                    status: 'running',
                },
            };
        }
        case 'webSearch': {
            const query = fs(item, 'query') || 'search';
            return {
                tool: {
                    icon: '🔍',
                    label: `search: ${query.slice(0, 80)}`,
                    toolType: 'search' as const,
                    detail: query,
                    stepRef: `codex-app:item:${id}`,
                    status: 'running',
                },
            };
        }
        case 'mcpToolCall': {
            const server = fs(item, 'server') || 'mcp';
            const tool = fs(item, 'tool') || 'call';
            return {
                tool: {
                    icon: '🔧',
                    label: `${server}/${tool}`,
                    toolType: 'tool' as const,
                    detail: `${server}/${tool}`,
                    stepRef: `codex-app:item:${id}`,
                    status: 'running',
                },
            };
        }
        case 'collabAgentToolCall': {
            const prompt = fs(item, 'prompt');
            return {
                tool: {
                    icon: '🤖',
                    label: `sub-agent: ${prompt.slice(0, 60) || 'collab'}`,
                    toolType: 'tool' as const,
                    detail: prompt,
                    stepRef: `codex-app:item:${id}`,
                    status: 'running',
                },
            };
        }
        case 'reasoning': {
            const initialReasoning = extractReasoningText(item);
            if (!initialReasoning) return null;
            return {
                tool: {
                    icon: '💭',
                    label: initialReasoning.length > 80 ? initialReasoning.slice(0, 79) + '…' : initialReasoning,
                    toolType: 'thinking' as const,
                    detail: initialReasoning,
                    stepRef: `codex-app:item:${id}`,
                },
            };
        }
        case 'agentMessage':
        {
            // The app-server protocol classifies assistant messages with 'phase'
            // (MessagePhase = commentary | final_answer on AgentMessageThreadItem),
            // NOT 'channel'. Reading only 'channel' meant every protocol-conformant
            // commentary message looked untagged, so progress narration was appended
            // to the durable answer and shipped to Slack as one run-on paragraph.
            // 'channel'/'annotations.channel' remain as fallbacks for non-standard
            // builds. A message item with NO tag must RESET the sticky value to the
            // empty string rather than leave the previous item's in place: a stale
            // 'commentary' would swallow the final answer, a stale 'final' would leak
            // narration into it.
            const itemChannel = normalizeCodexAppMessagePhase(fs(item, 'phase'))
                || fs(item, 'channel')
                || fs((f(item, 'annotations') as EvRec) ?? {}, 'channel');
            return { channel: itemChannel, itemId: id, messageStarted: true };
        }
        case 'userMessage':
        case 'hookPrompt':
            return null;
        default:
            return null;
    }
}

/** Map the app-server 'phase' enum onto the channel vocabulary this adapter speaks.
 *  'final_answer' becomes 'final' so the sticky value stays truthy and a later
 *  untagged delta is not mistaken for a new phase-unknown message. */
function normalizeCodexAppMessagePhase(phase: string): string {
    if (phase === 'commentary') return 'commentary';
    if (phase === 'final_answer') return 'final';
    return '';
}

function handleAgentMessageDelta(params: EvRec): CodexAppEventResult | null {
    const delta = f(params, 'delta');
    if (typeof delta !== 'string') return null;
    // itemId is REQUIRED on AgentMessageDeltaNotification. Keeping it lets the
    // consumer detect a new message even when item/started was dropped or
    // buffered — item/completed cannot help, it returns null for agentMessage.
    // 'phase' is NOT part of the delta notification in the v2 schema; reading it
    // here is a forward-compat fallback for non-standard builds, not the path
    // that classifies conformant streams.
    const channel = normalizeCodexAppMessagePhase(fs(params, 'phase'))
        || fs(params, 'channel')
        || undefined;
    const itemId = fs(params, 'itemId') || undefined;
    return stripUndefined({ text: delta, channel, itemId }) as CodexAppEventResult;
}

export interface CodexAppTextDecision {
    /** Text to append to ctx.fullText, or '' when the text is live-only. */
    readonly durable: string;
    /** Text to broadcast to the live UI, or '' when there is nothing to show. */
    readonly live: string;
}

/** Decide how one normalized codex-app event affects durable vs live text, and
 *  advance the sticky channel/item bookkeeping on ctx.
 *
 *  The discard rule keys on the PROVENANCE of what is already accumulated, not on
 *  the phase of whichever item arrives next:
 *
 *  1. Durable text appended under an explicit 'final' phase is PROTECTED. A turn
 *     may emit a trailing commentary or untagged item after its answer, and that
 *     must not erase an answer already delivered.
 *  2. Otherwise a NEW agentMessage item discards the unprotected accumulation
 *     (LAST-WINS), so successive phase-unknown items replace each other instead of
 *     concatenating — the Slack run-on artifact this fixes. Same tradeoff the
 *     codex NDJSON adapter already makes for untagged agent_messages.
 *  3. commentary text is live-only and never becomes durable.
 *
 *  Lives here rather than inline in spawn.ts so the decision is testable without a
 *  live runtime.
 */
export function applyCodexAppTextEvent(
    ctx: SpawnContext,
    parsed: CodexAppEventResult,
): CodexAppTextDecision {
    const startingItemId = parsed.messageStarted ? parsed.itemId : undefined;
    const deltaItemId = parsed.text !== undefined ? parsed.itemId : undefined;
    const boundaryFromDelta = deltaItemId !== undefined
        && deltaItemId !== ctx.codexAppActiveItemId;
    const newItemId = startingItemId ?? (boundaryFromDelta ? deltaItemId : undefined);

    if (newItemId !== undefined && newItemId !== ctx.codexAppActiveItemId) {
        const hadPreviousItem = ctx.codexAppActiveItemId !== undefined;
        ctx.codexAppActiveItemId = newItemId;
        // A boundary seen only through a changed delta itemId means item/started
        // was dropped, so THIS item's phase is unknown. Clearing the sticky value
        // stops the previous item's 'commentary' from swallowing this one.
        if (startingItemId === undefined) ctx.codexAppActiveChannel = '';
        // Never discard on the first item, and never discard a protected answer.
        if (hadPreviousItem && !ctx.codexAppDurableIsFinal) {
            ctx.fullText = '';
            ctx.outputTextStarted = false;
        }
        // RESTATEMENT COLLAPSE (#517). The protected accumulation above is what
        // makes a multi-item answer whole; it is also what lets an item that
        // REPEATS the previous one arrive as one paragraph printed twice. So the
        // surviving text becomes a candidate: if the incoming item turns out to
        // start with it, the earlier copy is removed and the new item stands
        // alone. Clearing the latch instead would fix this case and truncate
        // every genuine continuation.
        ctx.codexAppItemText = '';
        ctx.codexAppRestatementCandidate = hadPreviousItem && ctx.fullText
            ? ctx.fullText
            : undefined;
    }
    // After the boundary, so this event's own phase wins over the cleared sticky.
    if (parsed.channel !== undefined) ctx.codexAppActiveChannel = parsed.channel;

    if (!parsed.text) return { durable: '', live: '' };
    const effectiveChannel = parsed.channel || ctx.codexAppActiveChannel;
    if (effectiveChannel === 'commentary') return { durable: '', live: parsed.text };
    if (effectiveChannel === 'final') ctx.codexAppDurableIsFinal = true;
    // Deltas are token-granular, so the decision is made incrementally: keep the
    // candidate alive while this item is still a PREFIX of it, drop it the moment
    // the two diverge, and collapse as soon as the item covers it entirely. The
    // comparison stops the first time the item outgrows the candidate either way,
    // so it is bounded by the candidate's own length rather than by the stream.
    if (ctx.codexAppRestatementCandidate !== undefined) {
        const candidate = ctx.codexAppRestatementCandidate;
        const itemText = (ctx.codexAppItemText ?? '') + parsed.text;
        ctx.codexAppItemText = itemText;
        if (itemText.startsWith(candidate)) {
            ctx.fullText = ctx.fullText.slice(candidate.length);
            ctx.codexAppRestatementCandidate = undefined;
        } else if (!candidate.startsWith(itemText)) {
            ctx.codexAppRestatementCandidate = undefined;
        }
    }
    return { durable: parsed.text, live: parsed.text };
}

function handleReasoningDelta(params: EvRec): CodexAppEventResult | null {
    const delta = f(params, 'delta');
    if (typeof delta !== 'string') return null;
    return {
        tool: {
            icon: '💭',
            label: delta.length > 80 ? delta.slice(0, 79) + '…' : delta,
            toolType: 'thinking' as const,
            detail: delta,
        },
    };
}

function handleReasoningSummaryPartAdded(params: EvRec): CodexAppEventResult | null {
    const summaryIndex = f(params, 'summaryIndex');
    if (typeof summaryIndex !== 'number' || summaryIndex <= 0) return null;
    return {
        tool: {
            icon: '💭',
            label: '\n',
            toolType: 'thinking' as const,
            detail: '\n',
        },
    };
}

function handleItemCompleted(params: EvRec, ctx: SpawnContext): CodexAppEventResult | null {
    const item = f(params, 'item') as EvRec | undefined;
    if (!item) return null;

    const type = fs(item, 'type');
    const id = fs(item, 'id');

    if (type === 'agentMessage') {
        return null;
    }

    if (type === 'userMessage' || type === 'hookPrompt') {
        return null;
    }
    if (type === 'reasoning') {
        const completedReasoning = extractReasoningText(item);
        if (!ctx.thinkingBuf && completedReasoning) {
            return {
                tool: {
                    icon: '💭',
                    label: completedReasoning.length > 80 ? completedReasoning.slice(0, 79) + '…' : completedReasoning,
                    toolType: 'thinking' as const,
                    detail: completedReasoning,
                    stepRef: `codex-app:item:${id}`,
                    status: 'done',
                },
                flushThinking: true,
            };
        }
        return { flushThinking: true };
    }

    const itemStatus = f(item, 'status');
    const failed = typeof itemStatus === 'string'
        ? itemStatus === 'failed'
        : (itemStatus as EvRec | undefined)?.['type'] === 'failed';
    return {
        tool: {
            icon: failed ? '❌' : '✅',
            label: `${type} ${failed ? 'failed' : 'completed'}`,
            toolType: 'tool' as const,
            stepRef: `codex-app:item:${id}`,
            status: failed ? 'failed' : 'completed',
        },
    };
}

function extractReasoningText(item: EvRec): string {
    const content = f(item, 'content');
    const summary = f(item, 'summary');
    const contentText = textParts(content);
    if (contentText) return contentText;
    return textParts(summary);
}

function textParts(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (!Array.isArray(value)) return '';
    return value
        .map((entry) => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object' && typeof (entry as EvRec)['text'] === 'string') {
                return String((entry as EvRec)['text']);
            }
            return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function handleTokenUsageUpdated(params: EvRec, ctx: SpawnContext): CodexAppEventResult {
    const usage = f(params, 'tokenUsage') as EvRec | undefined;
    const last = usage ? f(usage, 'last') as EvRec | undefined : undefined;
    if (last) {
        ctx.tokens = {
            input_tokens: (last['inputTokens'] as number) || 0,
            output_tokens: (last['outputTokens'] as number) || 0,
            ...(last['cachedInputTokens'] ? { cached_input_tokens: last['cachedInputTokens'] as number } : {}),
        };
    }
    return ctx.tokens ? { tokens: ctx.tokens } : {};
}

function handleError(params: EvRec): CodexAppEventResult {
    const error = f(params, 'error') as EvRec | undefined;
    const message = error ? fs(error, 'message') : 'unknown error';
    const willRetry = f(params, 'willRetry') as boolean || false;
    if (willRetry) {
        return {
            tool: {
                icon: '⚠️',
                label: `retrying: ${message.slice(0, 80)}`,
                toolType: 'tool' as const,
                detail: message,
            },
        };
    }
    return { text: `\n❌ Codex error: ${message}` };
}
