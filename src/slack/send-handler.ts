// ─── Slack Send Handler ──────────────────────────────
// Adapts the channel-agnostic ChannelSendRequest to Slack's Web API.

import type { ChannelSendRequest } from '../messaging/send.js';
import { slackTargetFromId } from '../messaging/slack-target.js';
import { getSlackSendClient, resolveSlackDmChannel, sendSlackText } from './send-only-client.js';
import { sendSlackFile } from './slack-file.js';

export async function slackSendHandler(
    req: ChannelSendRequest,
): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    const client = getSlackSendClient();
    if (!client.token) {
        return { ok: false, error: client.reason ?? 'slack_unavailable', status: client.status ?? 503 };
    }
    let target = req.target;
    if (!target) return { ok: false, error: 'slack_target_missing', status: 400 };

    // A U... id is a user, not a conversation: open the DM first.
    if (target.targetId.toUpperCase().startsWith('U')) {
        const dm = await resolveSlackDmChannel(client.token, target.targetId);
        if (!dm.ok || !dm.channelId) {
            return { ok: false, error: dm.error || 'dm_open_failed', status: 502 };
        }
        target = slackTargetFromId(dm.channelId, target.threadId ? { threadTs: target.threadId } : {});
    }

    switch (req.type) {
        case 'text':
        // Slack's inline-keyboard analogue is Block Kit, whose callbacks need
        // the interactive-envelope routing that v1 puts out of scope. Sending
        // the text is better than silently dropping the message.
        case 'keyboard':
            if (!req.text) return { ok: false, error: 'empty_text', status: 400 };
            return sendSlackText(client.token, target, req.text);
        case 'photo':
        case 'document':
        case 'voice':
            if (!req.filePath) return { ok: false, error: 'missing_file_path', status: 400 };
            return sendSlackFile(client.token, target, req.filePath, req.caption ? { caption: req.caption } : {});
        default:
            return { ok: false, error: `unsupported_outbound_type_${String(req.type)}`, status: 400 };
    }
}
