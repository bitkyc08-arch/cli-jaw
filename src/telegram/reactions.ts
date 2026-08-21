import type { AckTransport } from '../messaging/ack-reaction.js';

// ─── Telegram Message Reactions (Bot API 7.0+) ───────
// Telegram does NOT accept arbitrary emoji here. ReactionTypeEmoji has a fixed
// allowlist, so a settings typo becomes a runtime API error unless it is checked
// before the call.
//
// Two consequences that look like bugs if you do not know them:
//   1. ✅ and ❌ are NOT on the list. Success/failure have to use 👍/👎, which is
//      also what hermes-agent settled on — not a stylistic choice.
//   2. A bot's previous reaction is REPLACED atomically, so there is no remove
//      step. Clearing first would show an empty state and cost an extra request.

/** ReactionTypeEmoji's complete allowlist, core.telegram.org/bots/api (2026-08-21). */
export const TELEGRAM_REACTION_EMOJI: ReadonlySet<string> = new Set([
    '\u2764', '\u{1F44D}', '\u{1F44E}', '\u{1F525}', '\u{1F970}', '\u{1F44F}',
    '\u{1F601}', '\u{1F914}', '\u{1F92F}', '\u{1F631}', '\u{1F92C}', '\u{1F622}',
    '\u{1F389}', '\u{1F929}', '\u{1F92E}', '\u{1F4A9}', '\u{1F64F}', '\u{1F44C}',
    '\u{1F54A}', '\u{1F921}', '\u{1F971}', '\u{1F974}', '\u{1F60D}', '\u{1F433}',
    '\u2764\u200D\u{1F525}', '\u{1F31A}', '\u{1F32D}', '\u{1F4AF}', '\u{1F923}',
    '\u26A1', '\u{1F34C}', '\u{1F3C6}', '\u{1F494}', '\u{1F928}', '\u{1F610}',
    '\u{1F353}', '\u{1F37E}', '\u{1F48B}', '\u{1F595}', '\u{1F608}', '\u{1F634}',
    '\u{1F62D}', '\u{1F913}', '\u{1F47B}', '\u{1F468}\u200D\u{1F4BB}', '\u{1F440}',
    '\u{1F383}', '\u{1F648}', '\u{1F607}', '\u{1F628}', '\u{1F91D}', '\u270D',
    '\u{1F917}', '\u{1FAE1}', '\u{1F385}', '\u{1F384}', '\u2603', '\u{1F485}',
    '\u{1F92A}', '\u{1F5FF}', '\u{1F192}', '\u{1F498}', '\u{1F649}', '\u{1F984}',
    '\u{1F618}', '\u{1F48A}', '\u{1F64A}', '\u{1F60E}', '\u{1F47E}',
    '\u{1F937}\u200D\u2642', '\u{1F937}', '\u{1F937}\u200D\u2640', '\u{1F621}',
]);

export function isTelegramReactionEmoji(emoji: string): boolean {
    return TELEGRAM_REACTION_EMOJI.has(emoji);
}

/**
 * Coerce an emoji into something Telegram will accept, or null to skip.
 *
 * Falls back rather than refusing: a bad config value should cost the reaction's
 * expressiveness, not the acknowledgement itself. Returning null would silently
 * turn the feature off for that user.
 */
export function coerceTelegramReaction(emoji: string, fallback = '\u{1F440}'): string | null {
    if (isTelegramReactionEmoji(emoji)) return emoji;
    return isTelegramReactionEmoji(fallback) ? fallback : null;
}

/**
 * The slice of grammY's Api this needs. Narrow on purpose so a test can supply it.
 *
 * The second parameter is grammY's per-call AbortSignal. Without it these calls
 * inherit the client's 500-second default timeout, which would outlive any
 * shutdown drain waiting on them.
 */
export type TelegramReactionApi = {
    raw: {
        // `signal` is deliberately loose. grammY types this parameter against the
        // abort-controller polyfill, which is structurally identical to the
        // platform AbortSignal but nominally distinct, so a precise type here
        // would reject the real Api object at the call site.
        setMessageReaction(args: Record<string, unknown>, signal?: never): Promise<unknown>;
    };
};

/** A reaction is decoration on top of the answer; it must never be the reason a
 *  shutdown hangs. Tight enough that remove+apply stays inside a drain deadline. */
export const TELEGRAM_REACTION_TIMEOUT_MS = 2500;

export type TelegramReactionOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
};

/**
 * Set (or clear) this bot's reaction on a message.
 *
 * Non-premium bots may set ONE reaction per message, so the array is length 0 or
 * 1 and never more. An empty array clears. grammY throws on API failure, which is
 * the reject-on-vendor-failure contract AckTransport requires.
 */
export async function setTelegramReaction(
    api: TelegramReactionApi,
    chatId: number | string,
    messageId: number,
    emoji: string | null,
    options: TelegramReactionOptions = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? TELEGRAM_REACTION_TIMEOUT_MS;
    // Both bounds matter and they mean different things: the caller's signal is a
    // lifecycle cancellation (shutdown), the timeout is protection against a
    // vendor call that simply never answers.
    const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
    await api.raw.setMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    }, signal as never);
}

/**
 * The ACK transport for a Telegram message.
 *
 * Exported so production and tests build the SAME seam. A test that defines its
 * own adapter proves only its own adapter: it would stay green if the wiring
 * later picked remove-then-add or dropped the allowlist coercion.
 *
 * `replace` is a vendor fact, not a preference — Telegram swaps a bot's reaction
 * atomically, so clearing first would show an empty state and cost a request.
 */
export function createTelegramAckTransport(
    api: TelegramReactionApi,
    chatId: number | string,
    messageId: number,
    options: TelegramReactionOptions = {},
): AckTransport {
    return {
        mode: 'replace',
        apply: async (emoji) => {
            await setTelegramReaction(api, chatId, messageId, emoji, options);
        },
        remove: async () => {
            // An empty reaction list is how Telegram clears; there is no
            // dedicated remove call.
            await setTelegramReaction(api, chatId, messageId, null, options);
        },
        coerce: (emoji) => coerceTelegramReaction(emoji),
    };
}
