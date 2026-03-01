// ─── submitMessage gateway ──────────────────────────
// Unified message submission for all interfaces (WebUI, REST, Telegram).
// Replaces duplicated intent/queue/orchestrate logic in server.ts + bot.ts.

import { isAgentBusy, enqueueMessage, messageQueue } from '../agent/spawn.js';
import { insertMessage } from '../core/db.js';
import { broadcast } from '../core/bus.js';
import {
    orchestrate, orchestrateContinue, orchestrateReset,
    isContinueIntent, isResetIntent,
} from './pipeline.js';
import { getState } from './state-machine.js';

export type SubmitResult = {
    action: 'started' | 'queued' | 'rejected';
    reason?: string;
    pending?: number;
    // backward-compat for REST consumers (chat.js expects these)
    queued?: true;
    continued?: true;
};

function runDetached(
    task: Promise<unknown>,
    label: string,
    meta: { origin: 'web' | 'cli' | 'telegram'; chatId?: string | number },
) {
    task.catch((err: unknown) => {
        const msg = (err as Error)?.message || String(err);
        console.error(`[gateway:${label}]`, msg);
        broadcast('orchestrate_done', {
            text: `[orchestrate error] ${msg}`,
            origin: meta.origin,
            chatId: meta.chatId,
            error: true,
        });
    });
}

export function submitMessage(
    text: string,
    meta: { origin: 'web' | 'cli' | 'telegram'; displayText?: string; skipOrchestrate?: boolean; chatId?: string | number },
): SubmitResult {
    const trimmed = text.trim();
    if (!trimmed) return { action: 'rejected', reason: 'empty' };

    const display = meta.displayText || trimmed;

    // ── continue intent (only when IDLE) ──
    if (getState() === 'IDLE' && isContinueIntent(trimmed)) {
        if (isAgentBusy()) return { action: 'rejected', reason: 'busy' };
        insertMessage.run('user', display, meta.origin, '');
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        if (!meta.skipOrchestrate) {
            runDetached(
                orchestrateContinue({ origin: meta.origin, chatId: meta.chatId, _skipInsert: true }),
                'continue',
                meta,
            );
        }
        return { action: 'started', continued: true };
    }

    // ── reset intent ──
    if (isResetIntent(trimmed)) {
        if (isAgentBusy()) return { action: 'rejected', reason: 'busy' };
        insertMessage.run('user', display, meta.origin, '');
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        if (!meta.skipOrchestrate) {
            runDetached(
                orchestrateReset({ origin: meta.origin, chatId: meta.chatId, _skipInsert: true }),
                'reset',
                meta,
            );
        }
        return { action: 'started' };
    }

    // ── busy → enqueue only ──
    // NOTE: insertMessage is NOT called here — processQueue() handles it.
    // This fixes the dual-insert bug where bot.ts called both enqueue + insert.
    if (isAgentBusy()) {
        enqueueMessage(trimmed, meta.origin, { chatId: meta.chatId });
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        return { action: 'queued', pending: messageQueue.length, queued: true };
    }

    // ── idle → start immediately ──
    insertMessage.run('user', display, meta.origin, '');
    broadcast('new_message', { role: 'user', content: display, source: meta.origin });
    if (!meta.skipOrchestrate) {
        runDetached(
            orchestrate(trimmed, { origin: meta.origin, chatId: meta.chatId, _skipInsert: true }),
            'orchestrate',
            meta,
        );
    }
    return { action: 'started' };
}
