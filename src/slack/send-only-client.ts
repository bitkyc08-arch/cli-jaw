// ─── Slack Send-Only Client ──────────────────────────
// Outbound path that works with just the bot token, independent of whether the
// Socket Mode inbound connection is up. Mirrors src/discord/send-only-client.ts.

import { settings } from '../core/config.js';
import type { RemoteTarget } from '../messaging/types.js';
import { slackApi, describeSlackError, slackFailure, type SlackFetch } from './api.js';
import { abortableDelay } from '../messaging/outbound-lifecycle.js';
import { chunkSlackMessage, toMrkdwn } from './format.js';
import { MAX_INLINE_RATE_LIMIT_MS, classifySendFailure, retryAfterMs } from '../messaging/retry.js';
import { redactOutboundPayload } from '../messaging/redact.js';
import { log } from '../core/logger.js';

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

/** One record per Slack message that actually landed.
 *
 *  This is the ONLY place every Slack post is visible. `sendChannelOutput` sees
 *  a subset — the dispatch settle path, the queued reply, the recovered-queue
 *  forwarder, and the generic forwarder all call this transport directly — so an
 *  audit that reads only `outbound.send` misses exactly the paths most likely to
 *  double.
 *
 *  The two records are NOT interchangeable and must not be summed: a send routed
 *  through the choke point emits `outbound.send` AND lands here. `slack.post` is
 *  the post-level count, `outbound.send` the request-level one.
 *
 *  Emitted per chunk rather than once at the end, because a long answer is
 *  several posts and a failure partway leaves the earlier ones on screen.
 *  Recording once on full success would report nothing for a send the user can
 *  already read — the direction that hides a duplicate. `index`/`of` keep the
 *  pieces recognizable as one answer.
 *
 *  No body: destination and shape, never the words. */
function recordSlackPost(target: RemoteTarget, index: number, of: number): void {
    log.event('slack.post', {
        target: target.targetId,
        ...(target.threadId ? { threaded: true } : {}),
        index,
        of,
    });
}

export async function sendSlackText(
    token: string,
    target: RemoteTarget,
    text: string,
    options: { fetchImpl?: SlackFetch; blocks?: unknown; signal?: AbortSignal; requireBodyDelivery?: boolean } = {},
): Promise<{ ok: boolean; error?: string; status?: number; ts?: string }> {
    const chunks = chunkSlackMessage(toMrkdwn(text));
    if (options.requireBodyDelivery && !chunks.some(chunk => chunk.trim().length > 0)) {
        return slackFailure('empty_message', 400);
    }
    // The FIRST chunk's ts. A caller that wants to remove what it just posted —
    // the queue notice — needs a handle, and the first message is the one the
    // user sees, so it is the stable one to name.
    let firstTs: string | undefined;
    // `text` is masked inside chunkSlackMessage(); `blocks` bypassed masking
    // entirely (#408). Computed once, before the loop, so the first send and the
    // rate-limit retry below carry the same value — masking only the first would
    // put the original back on the wire the moment Slack throttled us.
    const safeBlocks = options.blocks ? redactOutboundPayload(options.blocks) : undefined;
    const callOpts = {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
    };
    for (const [index, chunk] of chunks.entries()) {
        // A shutdown abort between chunks is a cancellation, not a vendor
        // failure — report it as its own error so no caller records a Slack
        // rejection (or closes a notice as answered) for a send we cut short.
        if (options.signal?.aborted) {
            return slackFailure('slack_send_aborted', 499);
        }
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
            callOpts,
        );
        if (result.ok) {
            if (index === 0 && result.data?.ts) firstTs = result.data.ts;
            // Recorded PER CHUNK, at the moment the post lands.
            //
            // Recording once after the loop counted a send, not a post: a chunked
            // answer whose third chunk failed put two messages on screen and
            // recorded nothing, which is the direction that hides a duplicate.
            // `index`/`of` keep a long answer readable as one answer.
            recordSlackPost(target, index, chunks.length);
        }
        if (!result.ok) {
            // Keep an abort recognizable end to end (#417): describeSlackError
            // would wrap it as 'Slack API error: slack_send_aborted', and
            // anything matching the raw code would then mislabel a cancellation.
            if (result.error === 'slack_send_aborted') {
                return slackFailure('slack_send_aborted', 499);
            }
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
                // Abortable: a shutdown must not sit out a rate-limit window.
                await abortableDelay(wait, options.signal);
                if (options.signal?.aborted) {
                    return slackFailure('slack_send_aborted', 499);
                }
                const retried = await slackApi<{ ts?: string }>(
                    token,
                    'chat.postMessage',
                    {
                        channel: target.targetId,
                        text: chunk,
                        ...(target.threadId ? { thread_ts: target.threadId } : {}),
                        ...(index === 0 && safeBlocks ? { blocks: safeBlocks } : {}),
                    },
                    callOpts,
                );
                if (retried.ok) {
                    // Without this a throttled first send leaves a notice nobody
                    // can delete: the retry is what actually created the message.
                    if (index === 0 && retried.data?.ts) firstTs = retried.data.ts;
                    // The retry is what put this chunk on screen, so it is the post
                    // that has to be recorded. Missing it would make every
                    // throttled answer partly invisible to a duplicate audit.
                    recordSlackPost(target, index, chunks.length);
                    continue;
                }
                if (retried.error === 'slack_send_aborted') {
                    return slackFailure('slack_send_aborted', 499);
                }
                return slackFailure(describeSlackError(retried.error, retried.data), retried.status, retried.retryAfterMs, retried.grantedScopes);
            }
            return slackFailure(describeSlackError(result.error, result.data), result.status, result.retryAfterMs, result.grantedScopes);
        }
    }
    // exactOptionalPropertyTypes: omit the key rather than sending undefined.
    return firstTs ? { ok: true, ts: firstTs } : { ok: true };
}
