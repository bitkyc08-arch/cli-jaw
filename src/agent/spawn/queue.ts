// Message queue controller — factory pattern to avoid spawn.ts circular imports.

import crypto from 'node:crypto';
import type { RuntimeOrigin, RemoteTarget } from '../../messaging/types.js';
import { groupQueueKey } from '../../messaging/session-key.js';
import { stripUndefined } from '../../core/strip-undefined.js';

type QueueItem = {
    id: string;
    prompt: string;
    source: RuntimeOrigin;
    scope: string;
    target?: RemoteTarget;
    chatId?: string | number;
    requestId?: string;
    ts: number;
};

export interface QueueDeps {
    isSpawnBusy(): boolean;
    hasBlockingWorkers(): boolean;
    hasPendingWorkerReplays(): boolean;
    insertMessage: { run(...args: any[]): any };
    getActiveChatSession(): string;
    insertQueuedMessage: { run(...args: any[]): any };
    deleteQueuedMessage: { run(...args: any[]): any };
    listQueuedMessages: { all(): Array<{ id: string; payload: string }> };
    broadcast(type: string, data: Record<string, any>, audience?: 'public' | 'internal'): void;
    importPipeline(): Promise<{
        orchestrate: (...args: any[]) => Promise<void>;
        orchestrateContinue: (...args: any[]) => Promise<void>;
        orchestrateReset: (...args: any[]) => Promise<void>;
        isContinueIntent: (text: string) => boolean;
        isResetIntent: (text: string) => boolean;
        drainPendingReplays: (opts: { origin: string }) => Promise<void>;
    }>;
    getWorkingDir(): string | null;
}

export const FALLBACK_MAX_RETRIES = 3;

export interface QueueController {
    enqueueMessage(prompt: string, source: RuntimeOrigin, meta?: {
        target?: RemoteTarget; chatId?: string | number; requestId?: string; scope?: string;
    }): string;
    removeQueuedMessage(id: string): { removed: QueueItem | null; pending: number };
    processQueue(): Promise<void>;
    setQueueHold(id: string, timeoutMs?: number): void;
    clearQueueHold(id?: string, opts?: { resume?: boolean }): void;
    getQueueHoldId(): string | null;
    clearRetryTimer(resumeQueue?: boolean): void;
    resetFallbackState(): void;
    getFallbackState(): Record<string, unknown>;
    getQueuedMessageSnapshotForScope(scope: string): Array<{
        id: string; prompt: string; source: RuntimeOrigin; ts: number;
    }>;
    readonly messageQueue: QueueItem[];
    readonly fallbackState: Map<string, any>;
    isRetryPending(): boolean;
    isQueueBusy(): boolean;
    purgeQueueOnStop(reason: string): void;
    readonly retryState: {
        timer: ReturnType<typeof setTimeout> | null;
        resolve: Function | null;
        origin: string | null;
        setTimer: (t: ReturnType<typeof setTimeout> | null) => void;
        setResolve: (r: any) => void;
        setOrigin: (o: string | null) => void;
        setIsEmployee: (v: boolean) => void;
    };
}

export function createQueueController(deps: QueueDeps): QueueController {
    function normalizeQueueItem(row: { id: string; payload: string }): QueueItem[] {
        try {
            const parsed = JSON.parse(row.payload) as Partial<QueueItem>;
            if (typeof parsed?.id !== 'string' || typeof parsed?.prompt !== 'string' || typeof parsed?.source !== 'string') {
                return [];
            }
            return [stripUndefined({
                id: parsed.id,
                prompt: parsed.prompt,
                source: parsed.source,
                scope: 'default',
                target: parsed.target,
                chatId: parsed.chatId,
                requestId: parsed.requestId,
                ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
            })];
        } catch {
            return [];
        }
    }

    function loadPersistedQueue(): QueueItem[] {
        return (deps.listQueuedMessages.all() as Array<{ id: string; payload: string }>).flatMap(normalizeQueueItem);
    }

    const messageQueue: QueueItem[] = loadPersistedQueue();
    if (messageQueue.length > 0) {
        console.log(`[queue] recovered ${messageQueue.length} persisted message(s) from previous session`);
    }
    let queueProcessing = false;

    // ─── 429 Retry Timer State ──────────────────────────
    // INVARIANT: single-main — 동시에 1개의 main spawnAgent만 존재한다고 가정.
    // 멀티 main task 도입 시 request-id 키 맵으로 전환 필요.
    let retryPendingTimer: ReturnType<typeof setTimeout> | null = null;
    let retryPendingResolve: ((v: { text: string; code: number }) => void) | null = null;
    let retryPendingOrigin: string | null = null;
    let retryPendingIsEmployee = false;

    const fallbackState = new Map();

    let queueHoldId: string | null = null;
    let queueHoldTimer: ReturnType<typeof setTimeout> | null = null;
    const QUEUE_HOLD_TIMEOUT_MS = 10_000;

    function clearRetryTimer(resumeQueue = true): void {
        if (retryPendingTimer) {
            clearTimeout(retryPendingTimer);
            retryPendingTimer = null;
            console.log('[jaw:retry] timer cancelled');

            if (retryPendingResolve) {
                deps.broadcast('agent_done', {
                    text: '⏹️ 재시도 취소됨',
                    error: true,
                    origin: retryPendingOrigin || 'web',
                    ...(retryPendingIsEmployee ? { isEmployee: true } : {}),
                }, retryPendingIsEmployee ? 'internal' : 'public');
                retryPendingResolve({ text: '', code: -1 });
                retryPendingResolve = null;
                retryPendingOrigin = null;
                retryPendingIsEmployee = false;
            }
            if (resumeQueue) processQueue();
        }
    }

    function resetFallbackState() {
        clearRetryTimer(true);
        fallbackState.clear();
        console.log('[jaw:fallback] state reset');
    }

    function getFallbackState() {
        return Object.fromEntries(fallbackState);
    }

    function setQueueHold(id: string, timeoutMs = QUEUE_HOLD_TIMEOUT_MS): void {
        if (queueHoldId && queueHoldId !== id) clearQueueHold();
        queueHoldId = id;
        if (queueHoldTimer) clearTimeout(queueHoldTimer);
        const holdId = id;
        queueHoldTimer = setTimeout(() => {
            if (queueHoldId !== holdId) return;
            console.warn(`[queue:hold] hold for ${holdId} expired after ${timeoutMs}ms`);
            clearQueueHold();
        }, timeoutMs);
        console.log(`[queue:hold] set for ${id}`);
    }

    function clearQueueHold(id?: string, opts?: { resume?: boolean }): void {
        if (id && queueHoldId !== id) return;
        if (queueHoldTimer) clearTimeout(queueHoldTimer);
        queueHoldTimer = null;
        const hadHold = queueHoldId !== null;
        if (hadHold) console.log(`[queue:hold] cleared (was ${queueHoldId})`);
        queueHoldId = null;
        if (hadHold && (opts?.resume ?? true)) queueMicrotask(() => processQueue());
    }

    function getQueueHoldId(): string | null {
        return queueHoldId;
    }

    function getQueuedMessageSnapshotForScope(scope: string): Array<{
        id: string; prompt: string; source: RuntimeOrigin; ts: number;
    }> {
        return messageQueue
            .filter(item => item.scope === scope)
            .map(item => ({
                id: item.id,
                prompt: item.prompt,
                source: item.source,
                ts: item.ts,
            }));
    }

    function queueUpdatePayload(): { pending: number; queued: ReturnType<typeof getQueuedMessageSnapshotForScope> } {
        return {
            pending: messageQueue.length,
            queued: getQueuedMessageSnapshotForScope('default'),
        };
    }

    function drainHeartbeatPendingSoon(): void {
        queueMicrotask(() => {
            import('../../memory/heartbeat.js')
                .then(({ drainPending }) => drainPending())
                .catch(err => console.error('[processQueue:heartbeat-drain]', (err as Error).message));
        });
    }

    function removeQueuedMessage(id: string): { removed: QueueItem | null; pending: number } {
        const idx = messageQueue.findIndex(item => item.id === id);
        if (idx === -1) return { removed: null, pending: messageQueue.length };
        const [removed] = messageQueue.splice(idx, 1);
        try { deps.deleteQueuedMessage.run(id); } catch (err) {
            console.warn(`[queue] DB delete failed for ${id}:`, (err as Error).message);
        }
        console.log(`[queue] -1 (${messageQueue.length} pending) removed=${id}`);
        deps.broadcast('queue_update', queueUpdatePayload());
        return { removed: removed!, pending: messageQueue.length };
    }

    function enqueueMessage(prompt: string, source: RuntimeOrigin, meta?: { target?: RemoteTarget; chatId?: string | number; requestId?: string; scope?: string }): string {
        const item: QueueItem = stripUndefined({
            id: crypto.randomUUID(),
            prompt,
            source,
            scope: meta?.scope || 'default',
            target: meta?.target,
            chatId: meta?.chatId,
            requestId: meta?.requestId,
            ts: Date.now(),
        });
        deps.insertQueuedMessage.run(item.id, JSON.stringify(item));
        messageQueue.push(item);
        console.log(`[queue] +1 (${messageQueue.length} pending)`);
        deps.broadcast('queue_update', queueUpdatePayload());
        processQueue();
        return item.id;
    }

    // Queue policy: "fair" — batch head runs, tail goes after remaining
    async function processQueue() {
        if (queueProcessing) return;

        if (!deps.isSpawnBusy() && !deps.hasBlockingWorkers() && deps.hasPendingWorkerReplays()) {
            queueMicrotask(() => {
                deps.importPipeline()
                    .then(({ drainPendingReplays }) => drainPendingReplays({ origin: 'system' }))
                    .catch(err => console.error('[processQueue:drain]', (err as Error).message));
            });
        }
        if (
            !deps.isSpawnBusy()
            && !deps.hasBlockingWorkers()
            && !deps.hasPendingWorkerReplays()
            && messageQueue.length === 0
            && !queueHoldId
        ) {
            drainHeartbeatPendingSoon();
        }

        if (
            deps.isSpawnBusy()
            || deps.hasBlockingWorkers()
            || messageQueue.length === 0
            || queueHoldId
        ) return;
        // NOTE: hasPendingWorkerReplays() is intentionally NOT gated here —
        // orchestrate() drains pending replays at entry (pipeline.ts drainPendingReplays),
        // so the queued user message still arrives AFTER the worker result. Keeping this
        // gate caused a deadlock (see devlog/_plan/260417_message_duplication/02_*).
        queueProcessing = true;

        const first = messageQueue[0]!;
        const groupKey = groupQueueKey(first.source, first.target);
        const batch: QueueItem[] = [];
        const remaining: QueueItem[] = [];

        for (const m of messageQueue) {
            const key = groupQueueKey(m.source, m.target);
            if (key === groupKey) batch.push(m);
            else remaining.push(m);
        }

        messageQueue.length = 0;
        if (batch.length > 1) {
            messageQueue.push(...remaining, ...batch.slice(1));
        } else {
            messageQueue.push(...remaining);
        }

        const item = batch[0]!;
        const combined = item.prompt;
        const source = item.source;
        const target = item.target;
        const chatId = item.chatId;
        const requestId = item.requestId;
        const origin: RuntimeOrigin = source || 'web';
        console.log(`[queue] processing 1/${batch.length} message(s) for ${groupKey}, ${messageQueue.length} remaining`);

        let inserted = false;
        try {
            deps.insertMessage.run('user', combined, source, '', deps.getWorkingDir(), deps.getActiveChatSession());
            deps.deleteQueuedMessage.run(item.id);
            inserted = true;
            deps.broadcast('new_message', { role: 'user', content: combined, source, fromQueue: true });
            deps.broadcast('queue_update', queueUpdatePayload());

            const { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } = await deps.importPipeline();
            const task = isResetIntent(combined)
                ? orchestrateReset({ origin, target, chatId, requestId, _skipInsert: true })
                : isContinueIntent(combined)
                    ? orchestrateContinue({ origin, target, chatId, requestId, _skipInsert: true })
                    : orchestrate(combined, { origin, target, chatId, requestId, _skipInsert: true });

            try {
                await task;
            } catch (err: unknown) {
                const msg = (err as Error).message;
                console.error('[queue:orchestrate]', msg);
                deps.broadcast('orchestrate_done', { text: `[error] ${msg}`, error: true, origin, chatId, target, requestId });
            }
        } catch (setupErr) {
            console.error('[queue:setup]', setupErr);
            if (!inserted) {
                messageQueue.unshift(item);
            } else {
                deps.broadcast('orchestrate_done', { text: `[error] setup failed: ${(setupErr as Error).message}`, error: true, origin, chatId, target, requestId });
            }
        } finally {
            queueProcessing = false;
            queueMicrotask(() => processQueue());
        }
    }

    function purgeQueueOnStop(reason: string): void {
        if (messageQueue.length === 0) return;
        const dropped = messageQueue.length;
        for (const item of messageQueue.splice(0)) {
            try { deps.deleteQueuedMessage.run(item.id); } catch { /* best-effort */ }
        }
        console.log(`[jaw:stop] cleared ${dropped} pending message(s) (reason=${reason})`);
        deps.broadcast('queue_update', queueUpdatePayload());
    }

    return {
        enqueueMessage,
        removeQueuedMessage,
        processQueue,
        setQueueHold,
        clearQueueHold,
        getQueueHoldId,
        clearRetryTimer,
        resetFallbackState,
        getFallbackState,
        getQueuedMessageSnapshotForScope,
        messageQueue,
        fallbackState,
        isRetryPending: () => !!retryPendingTimer,
        isQueueBusy: () => queueProcessing,
        purgeQueueOnStop,
        retryState: {
            get timer() { return retryPendingTimer; },
            get resolve() { return retryPendingResolve as Function | null; },
            get origin() { return retryPendingOrigin; },
            setTimer: (t: ReturnType<typeof setTimeout> | null) => { retryPendingTimer = t; },
            setResolve: (r: any) => { retryPendingResolve = r; },
            setOrigin: (o: string | null) => { retryPendingOrigin = o; },
            setIsEmployee: (v: boolean) => { retryPendingIsEmployee = v; },
        },
    };
}
