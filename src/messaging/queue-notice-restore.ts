// ─── Restoring queue notices after a restart ─────────
// The store (queue-notice-store.ts) keeps the platform message id; this turns that
// id back into a closed notice on the next boot.
//
// Always `expired`, never `answered`. The reasoning is the same as
// QueueNotice's own: a restart means this turn never delivered through its
// original handle, so deleting the notice would erase the only trace the user's
// message was ever received. The boot drain (#407) re-runs the queued item and
// posts its answer separately.
//
// Shared by all three transports rather than reimplemented per channel: the
// per-channel part is only how to build a NoticeTransport from a target and a
// message id, and each channel already exports that factory.

import type { MessengerChannel } from './types.js';
import type { NoticeTransport } from './queue-notice.js';
import type { QueueNoticeRecord, QueueNoticeStore } from './queue-notice-store.js';

export type RestoreQueueNoticesOptions = {
    store: QueueNoticeStore;
    channel: MessengerChannel;
    /** Replacement text for the rewrite. Resolved by the caller so this module stays free of i18n wiring. */
    expiredText: string;
    /**
     * Build the transport for one record, or null when it cannot be built yet.
     *
     * Null is a TEMPORARY condition — no token, client not connected — and the
     * record is kept so a later boot can still close it. A transport that throws
     * is a different thing: the vendor answered and said no.
     */
    transport: (record: QueueNoticeRecord & { messageId: string }) => NoticeTransport | null;
    onError?: (error: unknown) => void;
};

/**
 * Close out every notice this channel left behind.
 *
 * Sequential rather than parallel: these are vendor writes against one account,
 * and a burst of them on boot is how a restart turns into a rate-limit.
 */
export async function restoreQueueNotices(options: RestoreQueueNoticesOptions): Promise<void> {
    const records = options.store.listRestorable(options.channel);
    for (const record of records) {
        const messageId = record.messageId;
        if (!messageId) continue;
        const transport = options.transport({ ...record, messageId });
        // Kept, not closed: the transport may exist on the next boot.
        if (!transport) continue;
        try {
            await transport.edit(options.expiredText);
        } catch (error) {
            // Dropped anyway. A rewrite the vendor refused is not one that will
            // succeed next boot either, and keeping the row would make every
            // subsequent restart re-attempt it forever.
            options.onError?.(error);
        }
        options.store.close(record.requestId);
    }
}

