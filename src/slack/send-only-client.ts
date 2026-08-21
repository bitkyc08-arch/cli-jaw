// ─── Slack Send-Only Client ──────────────────────────
// Outbound path that works with just the bot token, independent of whether the
// Socket Mode inbound connection is up. Mirrors src/discord/send-only-client.ts.

import { settings } from '../core/config.js';
import type { RemoteTarget } from '../messaging/types.js';
import { slackApi, describeSlackError, slackFailure, type SlackFetch } from './api.js';
import { chunkSlackMessage, toMrkdwn } from './format.js';
import { MAX_INLINE_RATE_LIMIT_MS, classifySendFailure, retryAfterMs } from '../messaging/retry.js';
import { redactOutboundPayload } from '../messaging/redact.js';

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
        // Pass the payload so a missing im:write names itself.
        return { ok: false, error: describeSlackError(result.error || 'conversations_open_failed', result.data) };
    }
    return { ok: true, channelId };
}

export async function sendSlackText(
    token: string,
    target: RemoteTarget,
    text: string,
    options: { fetchImpl?: SlackFetch; blocks?: unknown } = {},
): Promise<{ ok: boolean; error?: string; status?: number; ts?: string }> {
    const chunks = chunkSlackMessage(toMrkdwn(text));
    // The FIRST chunk's ts. A caller that wants to remove what it just posted —
    // the queue notice — needs a handle, and the first message is the one the
    // user sees, so it is the stable one to name.
    let firstTs: string | undefined;
    // `text` is masked inside chunkSlackMessage(); `blocks` bypassed masking
    // entirely (#408). Computed once, before the loop, so the first send and the
    // rate-limit retry below carry the same value — masking only the first would
    // put the original back on the wire the moment Slack throttled us.
    const safeBlocks = options.blocks ? redactOutboundPayload(options.blocks) : undefined;
    for (const [index, chunk] of chunks.entries()) {
        const result = await slackApi<{ ts?: string }>(
            token,
            'chat.postMessage',
            {
                channel: target.targetId,
                text: chunk,
                // thread_ts is the PARENT ts (see slack-target.resolveSlackThreadTs)
                ...(target.threadId ? { thread_ts: target.threadId } : {}),
                ...(index === 0 && safeBlocks ? { blocks: safeBlocks } : {}),
            },
            options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
        );
        if (result.ok && index === 0 && result.data?.ts) firstTs = result.data.ts;
        if (!result.ok) {
            const classified = classifySendFailure({
                error: result.error,
                status: result.status,
                retryAfterMs: result.retryAfterMs,
            });
            const wait = result.retryAfterMs ?? retryAfterMs({
                error: result.error,
                status: result.status,
                retryAfterMs: result.retryAfterMs,
            });
            if (classified === 'rate-limit' && wait > 0 && wait <= MAX_INLINE_RATE_LIMIT_MS) {
                await new Promise((resolve) => setTimeout(resolve, wait));
                const retried = await slackApi<{ ts?: string }>(
                    token,
                    'chat.postMessage',
                    {
                        channel: target.targetId,
                        text: chunk,
                        ...(target.threadId ? { thread_ts: target.threadId } : {}),
                        ...(index === 0 && safeBlocks ? { blocks: safeBlocks } : {}),
                    },
                    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
                );
                if (retried.ok) {
                    // Without this a throttled first send leaves a notice nobody
                    // can delete: the retry is what actually created the message.
                    if (index === 0 && retried.data?.ts) firstTs = retried.data.ts;
                    continue;
                }
                return slackFailure(describeSlackError(retried.error, retried.data), retried.status, retried.retryAfterMs, retried.grantedScopes);
            }
            return slackFailure(describeSlackError(result.error, result.data), result.status, result.retryAfterMs, result.grantedScopes);
        }
    }
    // exactOptionalPropertyTypes: omit the key rather than sending undefined.
    return firstTs ? { ok: true, ts: firstTs } : { ok: true };
}
