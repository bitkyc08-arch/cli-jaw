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

export type SubmitResult = {
    action: 'started' | 'queued' | 'rejected';
    reason?: string;
    pending?: number;
    // backward-compat for REST consumers (chat.js expects these)
    queued?: true;
    continued?: true;
};

export function submitMessage(
    text: string,
    meta: { origin: 'web' | 'cli' | 'telegram'; displayText?: string; skipOrchestrate?: boolean; chatId?: string | number },
): SubmitResult {
    const trimmed = text.trim();
    if (!trimmed) return { action: 'rejected', reason: 'empty' };

    const display = meta.displayText || trimmed;

    // ── continue intent ──
    if (isContinueIntent(trimmed)) {
        if (isAgentBusy()) return { action: 'rejected', reason: 'busy' };
        insertMessage.run('user', display, meta.origin, '');
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        if (!meta.skipOrchestrate) orchestrateContinue({ origin: meta.origin, chatId: meta.chatId, _skipInsert: true });
        return { action: 'started', continued: true };
    }

    // ── reset intent ──
    if (isResetIntent(trimmed)) {
        if (isAgentBusy()) return { action: 'rejected', reason: 'busy' };
        insertMessage.run('user', display, meta.origin, '');
        broadcast('new_message', { role: 'user', content: display, source: meta.origin });
        if (!meta.skipOrchestrate) orchestrateReset({ origin: meta.origin, chatId: meta.chatId, _skipInsert: true });
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
        orchestrate(trimmed, { origin: meta.origin, chatId: meta.chatId, _skipInsert: true });
    }
    return { action: 'started' };
}
