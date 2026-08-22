// ─── Slack queue-notice transport ────────────────────
// Extracted from the inline binding in bot.ts so the restart path (#418) builds
// the SAME transport the live path does. A second hand-rolled copy is how the
// two drift — the live one already learned that message_not_found is a deletion
// that succeeded, and a restore-only copy would have to learn it again.

import type { NoticeTransport } from '../messaging/queue-notice.js';
import { deleteSlackMessage, describeSlackError, updateSlackMessage } from './api.js';

export function createSlackNoticeTransport(
    token: string,
    channelId: string,
    ts: string,
): NoticeTransport {
    return {
        delete: async (signal) => {
            const r = await deleteSlackMessage(token, channelId, ts,
                { ...(signal ? { signal } : {}) });
            // A notice that is already gone is a deletion that succeeded.
            if (!r.ok && r.error !== 'message_not_found') {
                throw new Error(describeSlackError(r.error, r.data));
            }
        },
        edit: async (text, signal) => {
            const r = await updateSlackMessage(token, channelId, ts, text,
                { ...(signal ? { signal } : {}) });
            if (!r.ok) throw new Error(describeSlackError(r.error, r.data));
        },
    };
}

