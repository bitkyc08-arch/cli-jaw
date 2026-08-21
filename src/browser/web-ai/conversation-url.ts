// Durable ChatGPT conversation-URL validation.
//
// Ported from agbrowse `web-ai/conversation-url.mjs` (parity2 020 slice 2.1,
// catalog B4/C-10). A conversation URL is durable only when it is https, on a
// known ChatGPT host, portless, traversal-free, and carries a `/c/<id>` path
// segment. Anything else — bare origins, foreign hosts, smuggling strings —
// must never be persisted as a conversationUrl or navigated to by recovery.

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const DURABLE_CONVERSATION_PATH = /(?:^|\/)c\/([A-Za-z0-9-]+)(?=\/|$)/;

/** Extract a durable ChatGPT conversation id, or null when the URL is unsafe. */
export function extractDurableConversationId(candidate: string | null | undefined): string | null {
    if (typeof candidate !== 'string' || candidate === '') return null;
    try {
        const url = new URL(candidate);
        const components = candidate.match(/^https:\/\/([^/?#]*)([^?#]*)/);
        const authority = components?.[1] || '';
        const pathname = components?.[2] || '';
        if (authority.includes('..') || authority.includes('\\') || authority.includes('\0')) return null;
        if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) return null;
        if (url.protocol !== 'https:') return null;
        if (url.port !== '' || authority.toLowerCase() !== url.hostname) return null;
        if (!CHATGPT_HOSTS.has(url.hostname)) return null;
        return url.pathname.match(DURABLE_CONVERSATION_PATH)?.[1] || null;
    } catch {
        return null;
    }
}

export function isDurableConversationUrl(candidate: string | null | undefined): boolean {
    return extractDurableConversationId(candidate) !== null;
}

