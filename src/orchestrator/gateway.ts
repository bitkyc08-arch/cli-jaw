// ─── submitMessage gateway ──────────────────────────
// Unified message submission for all interfaces (WebUI, REST, Telegram).
// Replaces duplicated intent/queue/orchestrate logic in server.ts + bot.ts.

import { randomUUID } from 'node:crypto';
import { isAgentBusy, enqueueMessage, messageQueue } from '../agent/spawn.js';
import { hasBlockingWorkers } from './worker-registry.js';
import { insertMessage } from '../core/db.js';
import { settings } from '../core/config.js';
import { broadcast } from '../core/bus.js';
import {
    orchestrate, orchestrateContinue, orchestrateReset,
    isContinueIntent, isResetIntent,
} from './pipeline.js';
import { getState } from './state-machine.js';
import { resolveOrcScope } from './scope.js';
import type { RuntimeOrigin, RemoteTarget } from '../messaging/types.js';

export type SubmitResult = {
    action: 'started' | 'queued' | 'rejected';
    reason?: string;
    pending?: number;
    requestId?: string;
    /** Queue item id (only present when action === 'queued') — lets clients
     * tag their optimistic bubble with `data-queued-id` so applyQueuedOverlay's
     * dedup catches it instead of rendering a duplicate. */
    queuedId?: string;
    // backward-compat for REST consumers (chat.js expects these)
    queued?: true;
    continued?: true;
};

// ── 5s dedup window ──
// L2 defense against duplicate inserts caused by:
//   (a) rapid user re-submit (impatience / button double-click)
//   (b) dispatch Bash-tool timeout → Boss hallucinates "in progress" → user retypes
// See devlog/_plan/260417_message_duplication/.
const DEDUP_WINDOW_MS = 5000;
const recentSubmissions = new Map<string, { ts: number; requestId: string }>();

function dedupKey(origin: string, text: string, chatId?: string | number): string {
    const normalized = text.trim().replace(/\s+/g, ' ');
    return `${origin}:${chatId ?? ''}:${normalized}`;
}

function gcRecentSubmissions(now: number): void {
    if (recentSubmissions.size < 32) return; // amortize GC
    for (const [k, v] of recentSubmissions) {
        if (now - v.ts > DEDUP_WINDOW_MS * 2) recentSubmissions.delete(k);
    }
}

/** Exposed for tests. Clears the dedup cache. */
export function __resetSubmitDedupForTest(): void {
    recentSubmissions.clear();
}

function runDetached(
    task: Promise<unknown>,
    label: string,
    meta: { origin: RuntimeOrigin; target?: RemoteTarget; chatId?: string | number; requestId?: string },
) {
    task.catch((err: unknown) => {
        const msg = (err as Error)?.message || String(err);
        console.error(`[gateway:${label}]`, msg);
        broadcast('orchestrate_done', {
            text: `[orchestrate error] ${msg}`,
            origin: meta.origin,
            target: meta.target,
            chatId: meta.chatId,
            requestId: meta.requestId,
            error: true,
        });
    });
}

export function submitMessage(
    text: string,
    meta: { origin: RuntimeOrigin; displayText?: string; skipOrchestrate?: boolean; target?: RemoteTarget; chatId?: string | number },
): SubmitResult {
    const trimmed = text.trim();
    if (!trimmed) return { action: 'rejected', reason: 'empty' };

    // Dedup: same (origin, chatId, normalized text) within 5s → reject as duplicate
    // and return the earlier requestId so the client can absorb it silently.
    const now = Date.now();
    const key = dedupKey(meta.origin, trimmed, meta.chatId);
    const prior = recentSubmissions.get(key);
    if (prior && now - prior.ts < DEDUP_WINDOW_MS) {
        console.log(`[gateway:dedup] suppressed duplicate (${now - prior.ts}ms window) origin=${meta.origin}`);
        return { action: 'rejected', reason: 'duplicate', requestId: prior.requestId };
    }
    gcRecentSubmissions(now);

    const display = meta.displayText || trimmed;
    const requestId = randomUUID();
    recentSubmissions.set(key, { ts: now, requestId });

    // ── continue intent (only when IDLE) ──
    const scope = resolveOrcScope({ origin: meta.origin, chatId: meta.chatId, workingDir: settings.workingDir || null });
    if (getState(scope) === 'IDLE' && isContinueIntent(trimmed)) {
        if (isAgentBusy()) return { action: 'rejected', reason: 'busy' };
        insertMessage.run('user', display, meta.origin, '', settings.workingDir || null);
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        if (!meta.skipOrchestrate) {
            runDetached(
                orchestrateContinue({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, _skipInsert: true }),
                'continue',
                { ...meta, requestId },
            );
        }
        return { action: 'started', continued: true, requestId };
    }

    // ── reset intent ──
    if (isResetIntent(trimmed)) {
        insertMessage.run('user', display, meta.origin, '', settings.workingDir || null);
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        if (!meta.skipOrchestrate) {
            runDetached(
                orchestrateReset({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, _skipInsert: true }),
                'reset',
                { ...meta, requestId },
            );
        }
        return { action: 'started', requestId };
    }

    // ── busy → enqueue only ──
    // NOTE: insertMessage is NOT called here — processQueue() handles it.
    // This fixes the dual-insert bug where bot.ts called both enqueue + insert.
    // NOTE: hasPendingWorkerReplays() is intentionally NOT gated — orchestrate()
    // drains pending replays at entry (pipeline.ts drainPendingReplays), so
    // starting immediately is safe and avoids the processQueue deadlock
    // documented in devlog/_plan/260417_message_duplication/02_*.
    if (isAgentBusy() || hasBlockingWorkers()) {
        const queuedId = enqueueMessage(trimmed, meta.origin, { target: meta.target, chatId: meta.chatId, requestId, scope });
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        return { action: 'queued', pending: messageQueue.length, queued: true, requestId, queuedId };
    }

    // ── idle → start immediately ──
    insertMessage.run('user', display, meta.origin, '', settings.workingDir || null);
    broadcast('new_message', { role: 'user', content: display, source: meta.origin });
    if (!meta.skipOrchestrate) {
        runDetached(
            orchestrate(trimmed, { origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, _skipInsert: true }),
            'orchestrate',
            { ...meta, requestId },
        );
    }
    return { action: 'started', requestId };
}
