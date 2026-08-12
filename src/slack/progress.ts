// ─── Slack live progress relay ──────────────────────
// Hermes-style "정보 수집 중…" status: one placeholder message posted right
// after a mention, then EDITED in place (chat.update) as the agent works, and
// finally replaced by the answer. Slack has no typing indicator for bots, so
// an edited message is the only honest progress surface.
//
// Design rules:
//   - ONE message per run. Never post a second status line; edit the first.
//   - Rate-limited edits. Slack's chat.update tier allows ~1/sec per channel;
//     bursty tool events would otherwise burn the budget and get throttled.
//   - Best-effort. A failed status post/edit must never break the answer path.
import { slackApi, describeSlackError, type SlackFetch } from './api.js';
import { startDraftStream, type DraftStreamOptions, type DraftTransport } from '../messaging/draft-stream.js';
import type { RemoteTarget } from '../messaging/types.js';
import { toMrkdwn } from './format.js';

/** Minimum gap between chat.update calls for one run (Slack tier limit). */
const EDIT_INTERVAL_MS = 1200;
/** Status text is a one-liner; long tool details would spam the channel. */
const MAX_STATUS_LEN = 140;
export type SlackProgressHandle = {
    /** Update the status line (rate-limited, best-effort). */
    update(text: string): void;
    /** Stop accepting updates and delete the placeholder if it still exists. */
    finish(): Promise<void>;
    /** The posted message ts, or null when the placeholder never landed. */
    ts(): string | null;
};
export function truncateStatus(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length <= MAX_STATUS_LEN ? line : `${line.slice(0, MAX_STATUS_LEN - 1)}…`;
}

/**
 * Map an `agent_tool` broadcast payload to a human status line.
 * Returns null when the event carries nothing worth showing.
 */
export function statusFromToolEvent(data: Record<string, unknown>, fallback: string): string | null {
    const label = typeof data['label'] === 'string' ? data['label'].trim() : '';
    const detail = typeof data['detail'] === 'string' ? data['detail'].trim() : '';
    if (!label && !detail) return null;
    const head = label || fallback;
    return truncateStatus(detail ? `${head} — ${detail}` : head);
}

export async function startSlackProgress(
    token: string,
    target: RemoteTarget,
    initialText: string,
    options: {
        fetchImpl?: SlackFetch;
        draftClock?: Pick<DraftStreamOptions, 'now' | 'setTimer' | 'clearTimer'>;
    } = {},
): Promise<SlackProgressHandle> {
    const fetchOpts = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
    const transport: DraftTransport = {
        async post(text) {
            const result = await slackApi<{ ts?: string }>(
                token,
                'chat.postMessage',
                {
                    channel: target.targetId,
                    text,
                    ...(target.threadId ? { thread_ts: target.threadId } : {}),
                },
                fetchOpts,
            );
            return result.ok && result.data?.ts ? result.data.ts : null;
        },
        async edit(ts, text) {
            const result = await slackApi(
                token, 'chat.update',
                { channel: target.targetId, ts, text },
                fetchOpts,
            );
            if (!result.ok) {
                throw Object.assign(new Error(result.error || 'chat_update_failed'), {
                    slackData: result.data,
                });
            }
        },
        async remove(ts) {
            const result = await slackApi(
                token, 'chat.delete',
                { channel: target.targetId, ts },
                fetchOpts,
            );
            if (!result.ok) {
                throw Object.assign(new Error(result.error || 'chat_delete_failed'), {
                    slackData: result.data,
                });
            }
        },
    };
    const stream = await startDraftStream(
        transport,
        toMrkdwn(truncateStatus(initialText)),
        {
            minEditIntervalMs: EDIT_INTERVAL_MS,
            maxChars: MAX_STATUS_LEN,
            ...options.draftClock,
            onError(operation, error) {
                const typed = error as Error & { slackData?: Record<string, unknown> };
                describeSlackError(typed.message || `${operation}_failed`, typed.slackData);
            },
        },
    );
    return {
        update(text: string): void {
            const next = truncateStatus(text);
            if (next) stream.update(toMrkdwn(next));
        },
        async finish(): Promise<void> {
            // The answer arrives as its own message, so the status placeholder
            // is deleted rather than left as a stale "working…" line.
            await stream.discard();
        },
        ts(): string | null { return stream.handle(); },
    };
}
