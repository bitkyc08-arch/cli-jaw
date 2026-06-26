import type { RemoteTarget } from './types.js';

/**
 * Extract a numeric Telegram `message_thread_id` from a RemoteTarget.
 *
 * Returns the positive thread id for a real forum topic, or `undefined` for
 * non-topic chats AND for the General topic (id = 1). Telegram sends to General
 * "as usual" with no `message_thread_id`, so callers wrap the result in
 * `stripUndefined(...)` and the wire payload is unchanged for non-forum chats.
 *
 * Used by the programmatic Telegram send paths (P0). Interactive `ctx.reply`
 * already auto-injects `message_thread_id` from the incoming message, so it does
 * not go through here.
 */
export function threadIdNumber(target?: RemoteTarget): number | undefined {
    const raw = target?.threadId;
    if (raw == null || raw === '') return undefined;
    const n = Number(raw);
    // n > 1 (not n > 0): General topic id=1 must send without message_thread_id.
    return Number.isInteger(n) && n > 1 ? n : undefined;
}
