// ─── Telegram Forwarding Utilities ───────────────────

export function escapeHtmlTg(text: string) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(md: string) {
    if (!md) return '';
    let html = escapeHtmlTg(md);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/(?<![*])\*(?![*])(.+?)(?<![*])\*(?![*])/g, '<i>$1</i>');
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
    return html;
}

export function chunkTelegramMessage(text: string, limit = 4096) {
    const raw = String(text || '');
    if (raw.length <= limit) return [raw];
    const chunks = [];
    let remaining = raw;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        let splitAt = remaining.lastIndexOf('\n', limit);
        if (splitAt < limit * 0.3) splitAt = limit;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
    }
    return chunks;
}

function isUserSafeWatchdogDiagnostic(text: string) {
    return /^❌\s*⏱️\s*응답 없음\s*—\s+/.test(String(text || '').trim());
}

/**
 * Listener lifecycle helper used by telegram bridge and unit tests.
 * Ensures attach/detach idempotency so re-init does not leak listeners.
 */
import type { Bot } from 'grammy';

type BroadcastForwarder = (type: string, data: Record<string, unknown>) => void | Promise<void>;

interface ForwarderLifecycleOptions {
    addListener?: (listener: BroadcastForwarder) => void;
    removeListener?: (listener: BroadcastForwarder) => void;
    buildForwarder?: (args: Record<string, unknown>) => BroadcastForwarder | null;
}

interface TelegramForwarderOptions {
    bot: Bot;
    getLastChatId: () => string | number | null | undefined;
    shouldSkip?: (data: Record<string, unknown>) => boolean;
    log?: (info: { chatId: string | number; preview: string }) => void;
    prefix?: string;
}

export function createForwarderLifecycle({
    addListener,
    removeListener,
    buildForwarder,
}: ForwarderLifecycleOptions = {}) {
    let forwarder: BroadcastForwarder | null = null;
    return {
        attach(args: Record<string, unknown> = {}) {
            if (forwarder) return forwarder;
            const next = typeof buildForwarder === 'function' ? buildForwarder(args) : null;
            if (typeof next !== 'function') {
                throw new TypeError('buildForwarder must return a function');
            }
            forwarder = next;
            if (typeof addListener === 'function') addListener(forwarder);
            return forwarder;
        },
        detach() {
            if (!forwarder) return;
            if (typeof removeListener === 'function') removeListener(forwarder);
            forwarder = null;
        },
        getCurrent() {
            return forwarder;
        },
    };
}

/**
 * Build a pure forwarder handler for `agent_done` broadcasts.
 * Side-effects are limited to bot API calls, so logic is unit-testable.
 */
export function createTelegramForwarder({
    bot,
    getLastChatId,
    shouldSkip = (_data: Record<string, unknown>) => false,
    log = (_info: { chatId: string | number; preview: string }) => { },
    prefix = '📡 ',
}: TelegramForwarderOptions) {
    return (type: string, data: Record<string, unknown>) => {
        if (type !== 'agent_done' || !data?.["text"]) return;
        if (data["error"] && !isUserSafeWatchdogDiagnostic(String(data["text"]))) return;
        if (shouldSkip(data)) return;

        const chatId = typeof getLastChatId === 'function' ? getLastChatId() : null;
        if (!chatId) return;

        const preview = String(data["text"]).slice(0, 200).replace(/\n/g, ' ');
        log({ chatId, preview });

        const html = markdownToTelegramHtml(String(data["text"]));
        const chunks = chunkTelegramMessage(html);
        for (const chunk of chunks) {
            Promise.resolve(
                bot.api.sendMessage(chatId, `${prefix}${chunk}`, { parse_mode: 'HTML' as const })
            ).catch(() =>
                Promise.resolve(
                    bot.api.sendMessage(chatId, `${prefix}${chunk.replace(/<[^>]+>/g, '')}`)
                ).catch(() => { })
            );
        }
    };
}
