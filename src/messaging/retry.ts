// ─── Send Failure Classification ─────────────────────
// One classifier for every Telegram send path. The file transport had a sound
// one; the text paths had none, and their fallback ladder treated a rate limit
// as a formatting problem — retrying immediately in another format, three
// times, which is the worst possible response to being told to slow down.

interface TelegramApiErrorLike {
    error_code?: number;
    statusCode?: number;
    status?: number;
    error?: string;
    code?: string;
    message?: string;
    /**
     * grammY's stable field for the Bot API's own text. `message` currently
     * embeds it, but that is Error formatting rather than a contract, so read
     * the documented field first.
     */
    description?: string;
    retryAfterMs?: number;
    parameters?: { retry_after?: number };
    constructor?: { name?: string };
}

function asApiError(err: unknown): TelegramApiErrorLike {
    return (err && typeof err === 'object') ? (err as TelegramApiErrorLike) : {};
}

/**
 * Why a send failed, which decides what may be done about it.
 *
 * - `format`: the payload was rejected for how it is written. Re-sending it
 *   differently is the correct response, and is what the fallback ladder is
 *   for.
 * - `rate-limit`: the server asked for a pause. Wait, then retry the SAME
 *   form. Falling back here multiplies the load that caused it.
 * - `ambiguous`: a network or server failure where the message may well have
 *   been accepted. Re-sending risks a duplicate the user sees twice, so the
 *   safe answer is to stop and report.
 */
export type SendFailureKind = 'format' | 'rate-limit' | 'ambiguous';

export function classifySendFailure(err: unknown): SendFailureKind {
    const e = asApiError(err);
    const slackError = typeof e.error === 'string' ? e.error : '';
    if (
        e.error_code === 429
        || e.statusCode === 429
        || e.status === 429
        || slackError === 'ratelimited'
        || e.parameters?.retry_after !== undefined
    ) return 'rate-limit';

    // 400 is Telegram's catch-all for a malformed request; only the parse and
    // entity variants mean "the same content, written differently, would work".
    if (e.error_code === 400) {
        const message = String(e.description ?? e.message ?? '').toLowerCase();
        const aboutFormatting = message.includes('parse')
            || message.includes('entit')
            || message.includes('markup')
            || message.includes('tag');
        return aboutFormatting ? 'format' : 'ambiguous';
    }
    return 'ambiguous';
}

/** Seconds Telegram asked us to wait, in milliseconds. Zero when unstated. */
export function retryAfterMs(err: unknown): number {
    const e = asApiError(err);
    if (typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0) {
        return e.retryAfterMs;
    }
    return (e.parameters?.retry_after ?? 0) * 1000;
}

/**
 * A rate limit longer than this is not worth blocking a send on.
 *
 * Holding the call open for a minute stalls everything queued behind it, so a
 * long pause is surfaced as a failure the caller can decide about instead.
 */
export const MAX_INLINE_RATE_LIMIT_MS = 5_000;

/**
 * Run a Telegram send under the classification policy.
 *
 * Direct `api.sendMessage` calls — keyboards, elicitation prompts, the Hub's
 * outbound relay — bypassed the rich-message ladder entirely, so a 429 there
 * was either swallowed by a bare `.catch(() => {})` or thrown at a caller with
 * no idea what to do about it. This gives them the same treatment the text
 * path gets: wait out a short rate limit and retry the same call, surface
 * anything else.
 *
 * Returns whether the send succeeded rather than throwing, because every one
 * of these call sites is a fire-and-forget notification whose failure should
 * be logged, not propagated into an agent turn.
 */
export async function sendWithRetryPolicy(
    send: () => Promise<unknown>,
    onFailure?: (err: unknown) => void,
): Promise<boolean> {
    try {
        await send();
        return true;
    } catch (err: unknown) {
        if (classifySendFailure(err) !== 'rate-limit') {
            onFailure?.(err);
            return false;
        }
        const wait = retryAfterMs(err);
        if (wait <= 0 || wait > MAX_INLINE_RATE_LIMIT_MS) {
            onFailure?.(err);
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
        try {
            await send();
            return true;
        } catch (retryErr: unknown) {
            onFailure?.(retryErr);
            return false;
        }
    }
}
