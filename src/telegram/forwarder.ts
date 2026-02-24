// ─── Telegram Forwarding Utilities ───────────────────

export function escapeHtmlTg(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(md) {
    if (!md) return '';
    let html = escapeHtmlTg(md);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/(?<![*])\*(?![*])(.+?)(?<![*])\*(?![*])/g, '<i>$1</i>');
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
    return html;
}

export function chunkTelegramMessage(text, limit = 4096) {
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

/**
 * Listener lifecycle helper used by telegram bridge and unit tests.
 * Ensures attach/detach idempotency so re-init does not leak listeners.
 */
export function createForwarderLifecycle({
    addListener,
    removeListener,
    buildForwarder,
} = {}) {
    let forwarder = null;
    return {
        attach(args = {}) {
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
    shouldSkip = () => false,
    log = () => { },
    prefix = '📡 ',
} = {}) {
    return (type, data) => {
        if (type !== 'agent_done' || !data?.text) return;
        if (data.error) return;
        if (shouldSkip(data)) return;

        const chatId = typeof getLastChatId === 'function' ? getLastChatId() : null;
        if (!chatId) return;

        const preview = String(data.text).slice(0, 200).replace(/\n/g, ' ');
        log({ chatId, preview });

        const html = markdownToTelegramHtml(data.text);
        const chunks = chunkTelegramMessage(html);
        for (const chunk of chunks) {
            Promise.resolve(
                bot.api.sendMessage(chatId, `${prefix}${chunk}`, { parse_mode: 'HTML' })
            ).catch(() =>
                Promise.resolve(
                    bot.api.sendMessage(chatId, `${prefix}${chunk.replace(/<[^>]+>/g, '')}`)
                ).catch(() => { })
            );
        }
    };
}
