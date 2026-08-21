// ─── Discord Reactions + Notice Transport ────────────
// discord.js's high-level helpers (Message.react/delete/edit, users.remove) do
// not forward request options, so there is no way to cancel them. The low-level
// client.rest does accept a signal, and applies it BOTH while a request is
// queued behind a rate limit and during the fetch itself — which matters here,
// because the built-in 15s network timeout does not cover queue time and is
// longer than any shutdown deadline worth having.
//
// So: reactions go through the high-level API (the returned MessageReaction is
// the only reliable way to remove a CUSTOM emoji, since discord.js caches those
// by id rather than by the name:id form we send), and notice cleanup goes
// through REST where cancellation is real.

import { Routes } from 'discord.js';
import type { Message, MessageReaction } from 'discord.js';
import type { AckTransport } from '../messaging/ack-reaction.js';
import type { NoticeTransport } from '../messaging/queue-notice.js';

/** A reaction is decoration on the answer; it must never hold a shutdown open. */
export const DISCORD_REACTION_TIMEOUT_MS = 2500;

/**
 * The ACK transport for one inbound Discord message.
 *
 * Exported so production and tests build the SAME seam — a test that defines its
 * own adapter proves only that adapter, and would stay green if the wiring later
 * picked the wrong transition mode.
 */
export function createDiscordAckTransport(message: Message): AckTransport {
    // The REST identifier discord.js resolved for each emoji we applied.
    //
    // Two reasons not to re-derive it: discord.js caches CUSTOM reactions under
    // the emoji ID rather than the `name:id` form we send, so a cache lookup
    // silently misses; and the reaction returned by react() already carries the
    // canonical identifier the removal route needs.
    const applied = new Map<string, string>();

    /** Bounded on every call. A reaction is decoration on the answer, so it must
     *  never be the reason a shutdown drain runs out of time — and discord.js's
     *  own 15s network timeout does not cover rate-limit queue time. */
    const bounded = () => ({ signal: AbortSignal.timeout(DISCORD_REACTION_TIMEOUT_MS) });

    return {
        // Discord has no atomic replace, so the old reaction must come off first.
        mode: 'remove-then-add',
        apply: async (emoji) => {
            // react() resolves the emoji (including custom ones) and URL-encodes
            // the path segment; hand-rolling that would need encodeURIComponent or
            // Discord answers 10014 Unknown Emoji.
            const reaction: MessageReaction = await message.react(emoji);
            applied.set(emoji, reaction.emoji.identifier);
        },
        remove: async (emoji) => {
            const identifier = applied.get(emoji)
                ?? message.reactions.cache.find(r =>
                    r.emoji.identifier === emoji || r.emoji.name === emoji)?.emoji.identifier;
            applied.delete(emoji);
            if (!identifier) return;
            // Low-level so the call is actually bounded: users.remove() forwards
            // no request options, so its request can outlive the drain.
            await message.client.rest.delete(
                Routes.channelMessageOwnReaction(message.channelId, message.id, identifier),
                bounded(),
            );
        },
        // Unicode and the custom `name:id` form both pass through unchanged.
        coerce: (emoji) => emoji,
    };
}

/**
 * The queue-notice transport for a posted Discord message.
 *
 * Uses client.rest rather than message.delete()/edit() purely for cancellation:
 * the high-level calls cannot receive the shutdown drain's signal, so a stuck
 * cleanup would outlive the drain that is supposed to bound it.
 */
export function createDiscordNoticeTransport(message: Message): NoticeTransport {
    const route = Routes.channelMessage(message.channelId, message.id);
    return {
        delete: async (signal) => {
            await message.client.rest.delete(route, signal ? { signal } : {});
        },
        edit: async (text, signal) => {
            await message.client.rest.patch(route, {
                body: { content: text },
                ...(signal ? { signal } : {}),
            });
        },
    };
}
