// ─── Boot-time queue-notice restore ──────────────────
// Runs the per-channel restore (#418) for every enabled channel, before the boot
// drain (#407) re-runs the queued turns themselves.
//
// The channel modules are imported lazily. server.ts already reaches them through
// the transport registry rather than directly, and a static import here would pull
// three gateway clients into the boot path of an instance that enabled none of
// them.

import { log } from '../core/logger.js';
import { logErrorText } from './redact.js';
import { getEnabledChannels } from './runtime.js';
import { getQueueNoticeStore } from './queue-notice-store.js';
import type { MessengerChannel } from './types.js';

const RESTORERS: Record<MessengerChannel, () => Promise<() => Promise<void>>> = {
    slack: async () => (await import('../slack/bot.js')).restoreSlackQueueNotices,
    telegram: async () => (await import('../telegram/bot.js')).restoreTelegramQueueNotices,
    discord: async () => (await import('../discord/bot.js')).restoreDiscordQueueNotices,
};

/**
 * Close out every notice the previous run left behind.
 *
 * One channel's failure must not stop the others: these are independent vendor
 * calls, and a Slack outage is not a reason to leave a Telegram notice claiming
 * the agent is still working.
 */
export async function restoreQueueNoticesForEnabledChannels(): Promise<void> {
    // No store means messaging never initialized; there is nothing to restore.
    if (!getQueueNoticeStore()) return;
    for (const channel of getEnabledChannels()) {
        try {
            const restore = await RESTORERS[channel]();
            await restore();
        } catch (error) {
            log.warn(`[messaging:queue-notice] ${channel} restore failed:`, logErrorText(error));
        }
    }
}

