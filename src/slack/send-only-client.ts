// ─── Slack Send-Only Client ──────────────────────────
// Outbound path that works with just the bot token, independent of whether the
// Socket Mode inbound connection is up. Mirrors src/discord/send-only-client.ts.

import { settings } from '../core/config.js';
import type { RemoteTarget } from '../messaging/types.js';
import { slackApi, describeSlackError, slackFailure, type SlackFetch } from './api.js';
import { chunkSlackMessage, toMrkdwn } from './format.js';

export type SlackSendClientResult =
    | { token: string; reason?: never; status?: never }
    | { token: null; reason: string; status: 400 | 503 };

export function invalidateSlackSendClient(): void {
    // no-op: the token is read fresh from settings on every call.
    // Present so runtime-settings.ts can invalidate symmetrically with Discord.
}

export function getSlackSendClient(): SlackSendClientResult {
    const sc = settings["slack"];
    if (!sc?.enabled) return { token: null, reason: 'slack_disabled', status: 503 };
    const token = typeof sc.botToken === 'string' ? sc.botToken.trim() : '';
    if (!token) return { token: null, reason: 'slack_bot_token_missing', status: 503 };
    return { token };
}

/** Resolve a DM conversation id for a user id, opening the DM if needed. */
export async function resolveSlackDmChannel(
    token: string,
    userId: string,
    fetchImpl?: SlackFetch,
): Promise<{ ok: boolean; channelId?: string; error?: string }> {
    if (!userId.toUpperCase().startsWith('U')) return { ok: true, channelId: userId };
    const result = await slackApi<{ channel?: { id?: string } }>(
        token, 'conversations.open', { users: userId }, fetchImpl ? { fetchImpl } : {},
    );
    const channelId = result.data?.channel?.id;
    if (!result.ok || !channelId) {
        return { ok: false, error: describeSlackError(result.error || 'conversations_open_failed') };
    }
    return { ok: true, channelId };
}

export async function sendSlackText(
    token: string,
    target: RemoteTarget,
    text: string,
    options: { fetchImpl?: SlackFetch } = {},
): Promise<{ ok: boolean; error?: string; status?: number }> {
    const chunks = chunkSlackMessage(toMrkdwn(text));
    for (const chunk of chunks) {
        const result = await slackApi(
            token,
            'chat.postMessage',
            {
                channel: target.targetId,
                text: chunk,
                // thread_ts is the PARENT ts (see slack-target.resolveSlackThreadTs)
                ...(target.threadId ? { thread_ts: target.threadId } : {}),
            },
            options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
        );
        if (!result.ok) {
            return slackFailure(describeSlackError(result.error), result.status);
        }
    }
    return { ok: true };
}
