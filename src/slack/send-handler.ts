// ─── Slack Send Handler ──────────────────────────────
// Adapts the channel-agnostic ChannelSendRequest to Slack's Web API.

import type { ChannelSendRequest } from '../messaging/send.js';
import { slackTargetFromId } from '../messaging/slack-target.js';
import { log } from '../core/logger.js';
import { logErrorText } from '../messaging/redact.js';
import type { ChannelOperation } from '../messaging/types.js';
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
            if (!req.text) return { ok: false, error: 'empty_text', status: 400 };
            return sendSlackText(client.token, target, req.text);
        case 'keyboard': {
            // Slack's inline-keyboard analogue is Block Kit, whose callbacks need
            // interactive-envelope routing this tree does not have, so
            // `interactiveActions` is declared false for Slack.
            //
            // This used to send the text anyway and say nothing. The message arrived
            // without its actions and the caller had no way to find out — a silent
            // loss of fidelity that read as success. Now the caller decides: opt in
            // with `interactiveFallback: 'text'` and get the text plus a recorded
            // downgrade, or get an explicit refusal.
            if (req.interactiveFallback !== 'text') {
                return {
                    ok: false,
                    error: 'interactive_actions_unsupported',
                    status: 501,
                    channel: 'slack',
                    unsupported: { operation: 'interactiveActions', reason: 'capability_not_declared' },
                };
            }
            if (!req.text) return { ok: false, error: 'empty_text', status: 400 };
            const result = await sendSlackText(client.token, target, req.text);
            return result.ok
                ? { ...result, downgraded: { operation: 'interactiveActions', to: 'text' } }
                : result;
        }
        case 'photo':
        case 'document':
        case 'voice': {
            if (!req.filePath) return { ok: false, error: 'missing_file_path', status: 400 };
            try {
                return await sendSlackFile(client.token, target, req.filePath, req.caption ? { caption: req.caption } : {});
            } catch (error) {
                // validateSlackFileSize throws 413 BEFORE any upload call. After
                // caption promotion (messaging/send.ts) the answer text lives only
                // in req.caption, so an oversized file used to take the whole
                // answer down with it — three 50 MiB+ refusals on suji, each with
                // a full answer attached (#517 round 2). Deliver the words.
                const status = (error as { statusCode?: number }).statusCode;
                const body = (req.caption ?? req.text ?? '').trim();
                if (status !== 413 || !body) throw error;
                // The filename is agent-chosen text and the message quotes the
                // size; both go through the masker like every other channel sink
                // (gate:redaction-sinks).
                log.warn('[slack:send] file exceeds transport limit — delivering caption as text', logErrorText(error));
                const operation: ChannelOperation = req.type === 'voice' ? 'voice' : 'fileUpload';
                const fallback = await sendSlackText(client.token, target, body);
                return fallback.ok
                    ? { ...fallback, downgraded: { operation, to: 'text' } }
                    : fallback;
            }
        }
        default:
            return { ok: false, error: `unsupported_outbound_type_${String(req.type)}`, status: 400 };
    }
}
