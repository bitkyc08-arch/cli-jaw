// ─── submitMessage gateway ──────────────────────────
// Unified message submission for all interfaces (WebUI, REST, Telegram).
// Replaces duplicated intent/queue/orchestrate logic in server.ts + bot.ts.

import { randomUUID } from 'node:crypto';
import { isAgentBusy, enqueueMessage, messageQueue } from '../agent/spawn.js';
import { hasBlockingWorkers, hasPendingWorkerReplays } from './worker-registry.js';
import { insertMessage } from '../core/db.js';
import { settings } from '../core/config.js';
import { broadcast } from '../core/bus.js';
import {
    orchestrate, orchestrateContinue, orchestrateReset,
    isContinueIntent, isResetIntent,
} from './pipeline.js';
import { getState } from './state-machine.js';
import type { RuntimeOrigin, RemoteTarget } from '../messaging/types.js';

export type SubmitResult = {
    action: 'started' | 'queued' | 'rejected';
    reason?: string;
    pending?: number;
    requestId?: string;
    // backward-compat for REST consumers (chat.js expects these)
    queued?: true;
    continued?: true;
};

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

    const display = meta.displayText || trimmed;
    const requestId = randomUUID();

    // ── continue intent (only when IDLE) ──
    if (getState() === 'IDLE' && isContinueIntent(trimmed)) {
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
    if (isAgentBusy() || hasBlockingWorkers() || hasPendingWorkerReplays()) {
        enqueueMessage(trimmed, meta.origin, { target: meta.target, chatId: meta.chatId, requestId });
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        return { action: 'queued', pending: messageQueue.length, queued: true, requestId };
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
