// P4 Part A — Bot API 10.1 rich messages (sendRichMessage), capability-gated.
//
// The installed @grammyjs/types (3.26.0) does NOT expose sendRichMessage yet (doc 03/05),
// so this stays dormant and falls back to parse_mode:'HTML' — which is already
// connection-agnostic and renders rich formatting on DMs, groups, and forum topics alike.
// When grammy / @grammyjs/types is bumped to a Bot API 10.1 build, sendRichMessage is used
// automatically with NO caller change. Testing requires that dependency bump + a live bot.
import type { Bot } from 'grammy';
import { stripUndefined } from '../core/strip-undefined.js';

// Minimal local shim for the not-yet-typed Bot API 10.1 surface (avoids a risky dep bump).
type RichCapableApi = {
    sendRichMessage?: (
        chatId: string | number,
        richMessage: { html?: string; markdown?: string },
        other?: { message_thread_id?: number },
    ) => Promise<unknown>;
};

/** True when the running grammy build exposes sendRichMessage (Bot API 10.1+). */
export function supportsRichMessage(bot: Bot): boolean {
    return typeof (bot.api as unknown as RichCapableApi).sendRichMessage === 'function';
}

/**
 * Send HTML, preferring Bot API 10.1 sendRichMessage when available, else the standard
 * parse_mode:'HTML' send. `message_thread_id` threads into a forum topic (omit for
 * General / non-forum). Caller handles a plaintext fallback on throw if desired.
 */
export async function sendRichOrHtml(
    bot: Bot,
    chatId: string | number,
    html: string,
    opts?: { message_thread_id?: number },
): Promise<void> {
    const api = bot.api as unknown as RichCapableApi;
    const message_thread_id = opts?.message_thread_id;
    if (typeof api.sendRichMessage === 'function') {
        await api.sendRichMessage(chatId, { html }, stripUndefined({ message_thread_id }));
        return;
    }
    await bot.api.sendMessage(chatId, html, stripUndefined({ parse_mode: 'HTML', message_thread_id }));
}
