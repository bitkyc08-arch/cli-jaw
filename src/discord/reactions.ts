// ─── Discord Reactions + Notice Transport ────────────
// discord.js's high-level helpers (Message.react/delete/edit, users.remove) do
// not forward request options, so there is no way to cancel them. The low-level
// client.rest does accept a signal, and applies it BOTH while a request is
// queued behind a rate limit and during the fetch itself — which matters here,
// because the built-in 15s network timeout does not cover queue time and is
// longer than any shutdown deadline worth having.
//
// So both reactions and notice cleanup go through client.rest. That also sidesteps
// a cache trap: discord.js stores CUSTOM reactions under the emoji ID rather than
// the name:id form we send, so resolving a removal from the cache silently misses.
// Sending the identifier we already know avoids the lookup entirely.

import { Routes } from 'discord.js';
import type { Message } from 'discord.js';
import type { AckTransport } from '../messaging/ack-reaction.js';
import type { NoticeTransport } from '../messaging/queue-notice.js';

/** A reaction is decoration on the answer; it must never hold a shutdown open. */
export const DISCORD_REACTION_TIMEOUT_MS = 2500;

/** Same reasoning for the notice: a stuck cleanup must not hold shutdown open. */
export const DISCORD_NOTICE_TIMEOUT_MS = 5000;

/**
 * The ACK transport for one inbound Discord message.
 *
 * Exported so production and tests build the SAME seam — a test that defines its
 * own adapter proves only that adapter, and would stay green if the wiring later
 * picked the wrong transition mode.
 */
export function createDiscordAckTransport(message: Message): AckTransport {
    // The canonical REST identifier for each emoji we applied, kept so removal
    // never has to consult discord.js's cache — which keys CUSTOM reactions by
    // emoji ID rather than the `name:id` form we send, and would miss.
    const applied = new Map<string, string>();

    /** Bounded on every call. A reaction is decoration on the answer, so it must
     *  never be the reason a shutdown drain runs out of time — and discord.js's
     *  own 15s network timeout does not cover rate-limit queue time. */
    const bounded = () => ({ signal: AbortSignal.timeout(DISCORD_REACTION_TIMEOUT_MS) });

    return {
        // Discord has no atomic replace, so the old reaction must come off first.
        mode: 'remove-then-add',
        apply: async (emoji) => {
            // Low-level so this is actually cancellable: message.react() forwards
            // no request options, so a rate-limited add can outlive the drain.
            //
            // The identifier is resolved locally rather than by react(): a custom
            // emoji already arrives as `name:id`, which IS the REST identifier,
            // and a unicode one is itself. encodeURIComponent is required or
            // Discord answers 10014 Unknown Emoji.
            const identifier = emoji;
            await message.client.rest.put(
                Routes.channelMessageOwnReaction(message.channelId, message.id, identifier),
                bounded(),
            );
            applied.set(emoji, identifier);
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
    // A per-call timeout is composed even when the caller supplies nothing.
    // QueueNotice pins whichever signal the FIRST close receives, and ordinary
    // delivery closes without one — so relying on the shutdown drain to provide
    // it would leave the common path unbounded.
    const bounded = (signal?: AbortSignal): AbortSignal => {
        const timeout = AbortSignal.timeout(DISCORD_NOTICE_TIMEOUT_MS);
        return signal ? AbortSignal.any([signal, timeout]) : timeout;
    };
    return {
        delete: async (signal) => {
            await message.client.rest.delete(route, { signal: bounded(signal) });
        },
        edit: async (text, signal) => {
            await message.client.rest.patch(route, {
                body: { content: text },
                signal: bounded(signal),
            });
        },
    };
}
