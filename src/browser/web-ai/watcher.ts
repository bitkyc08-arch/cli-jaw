import { drainPendingWebAiNotifications } from './notifications.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import {
    enqueueWebAiSessionNotification,
    getSession,
    listSessions,
    setSessionNotifyOnComplete,
    updateSessionResult,
    updateSessionStatus,
} from './session.js';
import type { WebAiOutput, WebAiSessionRecord, WebAiVendor } from './types.js';

export interface StartWebAiWatcherInput {
    port: number;
    vendor: WebAiVendor;
    sessionId: string;
    timeoutMs: number;
    pollIntervalSeconds?: number;
    allowCopyMarkdownFallback?: boolean;
    pollOnce: (input: { vendor: WebAiVendor; session: string; timeout: number; allowCopyMarkdownFallback?: boolean }) => Promise<WebAiOutput>;
}

export interface ResumeStoredWebAiWatchersInput {
    port: number;
    vendor?: WebAiVendor;
    pollIntervalSeconds?: number;
    pollOnce: StartWebAiWatcherInput['pollOnce'];
}

export interface WebAiWatcherState {
    sessionId: string;
    vendor: WebAiVendor;
    startedAt: string;
    deadlineAt: string;
    status: 'running' | 'complete' | 'timeout' | 'error';
}

const activeWatchers = new Map<string, WebAiWatcherState & { timer?: ReturnType<typeof setTimeout> }>();
const POLL_TICK_SECONDS = 30;
const POLL_INTERVAL_SECONDS = 30;
const TERMINAL_SESSION_STATUSES = new Set(['complete', 'timeout', 'error']);
let pollQueue: Promise<void> = Promise.resolve();

export function startWebAiWatcher(input: StartWebAiWatcherInput): WebAiWatcherState {
    const existing = activeWatchers.get(input.sessionId);
    if (existing) return publicState(existing);
    const session = validateStartInput(input);
    const now = Date.now();
    const deadline = Date.parse(session.createdAt) + session.timeoutMs;
    if (now >= deadline) {
        markStale(session, 'session deadline already expired');
        throw new Error(`web-ai watcher session expired: ${input.sessionId}`);
    }
    const state: WebAiWatcherState & { timer?: ReturnType<typeof setTimeout> } = {
        sessionId: input.sessionId,
        vendor: session.vendor,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(deadline).toISOString(),
        status: 'running',
    };
    activeWatchers.set(input.sessionId, state);
    setSessionNotifyOnComplete(input.sessionId, true);
    updateSessionStatus(input.sessionId, 'streaming');
    scheduleTick(input, state, 0);
    return publicState(state);
}

export function listActiveWebAiWatchers(): WebAiWatcherState[] {
    return [...activeWatchers.values()].map(publicState);
}

export function stopWebAiWatchers(): void {
    for (const watcher of activeWatchers.values()) {
        if (watcher.timer) clearTimeout(watcher.timer);
    }
    activeWatchers.clear();
}

export function resumeStoredWebAiWatchers(input: ResumeStoredWebAiWatchersInput): WebAiWatcherState[] {
    const now = Date.now();
    const resumable = listSessions(stripUndefined({ vendor: input.vendor }))
        .filter((session) => session.notifyOnComplete)
        .filter((session) => session.status === 'sent' || session.status === 'streaming')
        .filter((session) => now < Date.parse(session.createdAt) + session.timeoutMs);
    return resumable.map((session) => startWebAiWatcher(stripUndefined({
        port: input.port,
        vendor: session.vendor,
        sessionId: session.sessionId,
        timeoutMs: Math.max(1, Date.parse(session.createdAt) + session.timeoutMs - now),
        pollIntervalSeconds: input.pollIntervalSeconds,
        pollOnce: input.pollOnce,
    })));
}

function scheduleTick(input: StartWebAiWatcherInput, state: WebAiWatcherState & { timer?: ReturnType<typeof setTimeout> }, delayMs: number): void {
    state.timer = setTimeout(() => {
        void runTick(input, state);
    }, delayMs);
    state.timer.unref?.();
}

async function runTick(input: StartWebAiWatcherInput, state: WebAiWatcherState & { timer?: ReturnType<typeof setTimeout> }): Promise<void> {
    if (Date.now() >= Date.parse(state.deadlineAt)) {
        state.status = 'timeout';
        markStale(input.sessionId, 'watcher deadline reached');
        activeWatchers.delete(input.sessionId);
        await drainPendingWebAiNotifications();
        return;
    }
    try {
        const result = await runSerializedPoll(() => input.pollOnce(stripUndefined({
            vendor: input.vendor,
            session: input.sessionId,
            timeout: POLL_TICK_SECONDS,
            allowCopyMarkdownFallback: input.allowCopyMarkdownFallback,
        })));
        if (result.ok && result.status === 'complete') {
            updateSessionResult({
                sessionId: input.sessionId,
                status: 'complete',
                ...(result.url ? { url: result.url, conversationUrl: result.url } : {}),
                ...(result.answerText ? { answerText: result.answerText } : {}),
            });
            state.status = 'complete';
            activeWatchers.delete(input.sessionId);
            await drainPendingWebAiNotifications();
            return;
        }
        const terminal = classifyTerminalResult(result);
        if (terminal) {
            state.status = 'error';
            updateSessionResult({ sessionId: input.sessionId, status: 'error', error: terminal.reason });
            enqueueWebAiSessionNotification(stripUndefined({
                sessionId: input.sessionId,
                type: terminal.type,
                reason: terminal.reason,
                error: result.error,
            }));
            activeWatchers.delete(input.sessionId);
            await drainPendingWebAiNotifications();
            return;
        }
        if (getSession(input.sessionId)?.status === 'timeout') updateSessionStatus(input.sessionId, 'streaming');
    } catch (e) {
        state.status = 'error';
        const error = (e as Error).message;
        updateSessionResult({
            sessionId: input.sessionId,
            status: 'error',
            error,
        });
        enqueueWebAiSessionNotification({
            sessionId: input.sessionId,
            type: classifyErrorEvent(error),
            reason: 'watcher poll failed',
            error,
        });
        activeWatchers.delete(input.sessionId);
        await drainPendingWebAiNotifications();
        return;
    }
    scheduleTick(input, state, normalizedPollIntervalMs(input.pollIntervalSeconds));
}

function publicState(state: WebAiWatcherState): WebAiWatcherState {
    return {
        sessionId: state.sessionId,
        vendor: state.vendor,
        startedAt: state.startedAt,
        deadlineAt: state.deadlineAt,
        status: state.status,
    };
}

function validateStartInput(input: StartWebAiWatcherInput): WebAiSessionRecord {
    const session = getSession(input.sessionId);
    if (!session) throw new Error(`web-ai watcher session not found: ${input.sessionId}`);
    if (session.vendor !== input.vendor) {
        throw new Error(`web-ai watcher vendor mismatch: session=${session.vendor} requested=${input.vendor}`);
    }
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
        throw new Error(`web-ai watcher cannot start terminal session ${input.sessionId}: ${session.status}`);
    }
    return session;
}

function normalizedPollIntervalMs(seconds: unknown): number {
    const parsed = Number(seconds ?? POLL_INTERVAL_SECONDS);
    const safeSeconds = Number.isFinite(parsed) ? Math.min(300, Math.max(1, Math.floor(parsed))) : POLL_INTERVAL_SECONDS;
    return safeSeconds * 1000;
}

function runSerializedPoll(task: () => Promise<WebAiOutput>): Promise<WebAiOutput> {
    const next = pollQueue.then(task, task);
    pollQueue = next.then(() => undefined, () => undefined);
    return next;
}

function markStale(sessionOrId: WebAiSessionRecord | string, reason: string): void {
    const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.sessionId;
    updateSessionResult({ sessionId, status: 'timeout', error: reason });
    enqueueWebAiSessionNotification({
        sessionId,
        type: 'web-ai.session.stale',
        reason,
    });
}

function classifyTerminalResult(result: WebAiOutput): { type: 'web-ai.provider.login-required' | 'web-ai.capability.unsupported' | 'web-ai.answer.failed'; reason: string } | null {
    const text = `${result.status || ''} ${result.error || ''} ${(result.warnings || []).join(' ')}`.toLowerCase();
    if (result.status === 'blocked' && /login|sign in|signin|auth|unauthorized/.test(text)) {
        return { type: 'web-ai.provider.login-required', reason: result.error || 'provider login required' };
    }
    if (/unsupported|not enabled|fail-closed|capability/.test(text)) {
        return { type: 'web-ai.capability.unsupported', reason: result.error || 'capability unsupported' };
    }
    if (result.status === 'error' || result.status === 'blocked') {
        return { type: 'web-ai.answer.failed', reason: result.error || `watcher terminal status: ${result.status}` };
    }
    return null;
}

function classifyErrorEvent(error: string): 'web-ai.provider.login-required' | 'web-ai.capability.unsupported' | 'web-ai.answer.failed' {
    const text = error.toLowerCase();
    if (/login|sign in|signin|auth|unauthorized/.test(text)) return 'web-ai.provider.login-required';
    if (/unsupported|not enabled|fail-closed|capability/.test(text)) return 'web-ai.capability.unsupported';
    return 'web-ai.answer.failed';
}
