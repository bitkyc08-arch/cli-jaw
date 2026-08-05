// ─── Codex AppServer Event Normalizer ────────────────
// Maps app-server JSON-RPC notifications to the same
// { tool, text, sessionId, tokens } shape spawn.ts expects.

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
        case 'userMessage':
        case 'hookPrompt':
            return null;
        default:
            return null;
    }
}

function handleAgentMessageDelta(params: EvRec): CodexAppEventResult | null {
    const delta = f(params, 'delta');
    if (typeof delta === 'string') return { text: delta };
    return null;
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
