// Bot API 10.1 rich messages — DEFAULT outbound text path (Bot API 10.1, grammy 1.44+).
//
// sendTelegramMarkdown sends raw agent markdown via sendRichMessage({ markdown }) in
// 32000-char chunks (spec limit 32768; margin for entity expansion). Rich Markdown is a
// superset of the markdown our agents emit (headings, lists, tables, code fences), so no
// conversion is needed. Per-chunk failure falls back to the legacy chain: HTML conversion
// with 4096 re-chunking, then tag-stripped plaintext. Older grammy builds (or test spies)
// without api.sendRichMessage take the HTML chain for the whole message.
//
// NOTE: static two-way import with forwarder.ts is intentional and benign — this module
// imports only hoisted function declarations, and forwarder.ts has zero runtime imports.
import type { Api } from 'grammy';
import { stripUndefined } from '../core/strip-undefined.js';
import { markdownToTelegramHtml, chunkTelegramMessage } from './forwarder.js';

export const RICH_MESSAGE_LIMIT = 32000;
const HTML_MESSAGE_LIMIT = 4096;

type MaybeRichApi = Pick<Api, 'sendMessage'> & Partial<Pick<Api, 'sendRichMessage'>>;

export interface RichSendOpts {
    message_thread_id?: number;
    business_connection_id?: string;
    direct_messages_topic_id?: number;
    /** Prepended to the FIRST chunk only (e.g. '📡 '). */
    prefix?: string;
}

/** True when the running grammy build exposes sendRichMessage (Bot API 10.1+). */
export function supportsRichMessage(api: MaybeRichApi): boolean {
    return typeof api.sendRichMessage === 'function';
}

/** Split markdown on paragraph > line boundaries without breaking code fences. */
export function chunkRichMarkdown(md: string, limit = RICH_MESSAGE_LIMIT): string[] {
    const raw = String(md || '');
    if (raw.length <= limit) return [raw];
    const chunks: string[] = [];
    let remaining = raw;
    while (remaining.length > limit) {
        chunks.push(remaining.slice(0, findMarkdownSafeSplit(remaining, limit)));
        remaining = remaining.slice(chunks[chunks.length - 1]!.length);
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}

function findMarkdownSafeSplit(raw: string, limit: number): number {
    // Candidate boundaries, best first: blank line, then newline — never inside a code fence.
    for (const boundary of ['\n\n', '\n']) {
        for (let i = limit; i > limit * 0.3; i -= 1) {
            if (!raw.startsWith(boundary, i - boundary.length)) continue;
            if (insideCodeFence(raw, i)) continue;
            return i;
        }
    }
    return limit; // hard split as last resort
}

function insideCodeFence(raw: string, index: number): boolean {
    let fences = 0;
    let at = 0;
    while (at < index) {
        const next = raw.indexOf('```', at);
        if (next < 0 || next >= index) break;
        fences += 1;
        at = next + 3;
    }
    return fences % 2 === 1;
}

function richOpts(opts?: RichSendOpts) {
    return stripUndefined({
        message_thread_id: opts?.message_thread_id,
        business_connection_id: opts?.business_connection_id,
        direct_messages_topic_id: opts?.direct_messages_topic_id,
    });
}

/**
 * Send markdown text, preferring Bot API 10.1 sendRichMessage; falls back per chunk to
 * parse_mode:'HTML' (re-chunked at 4096), then tag-stripped plaintext. Never throws for
 * a single bad chunk; rethrows only when every leg of the chain failed.
 */
export async function sendTelegramMarkdown(
    api: MaybeRichApi,
    chatId: string | number,
    markdown: string,
    opts?: RichSendOpts,
): Promise<void> {
    const prefix = opts?.prefix ?? '';
    if (!supportsRichMessage(api)) {
        await sendHtmlFallback(api, chatId, markdown, opts, prefix);
        return;
    }
    const chunks = chunkRichMarkdown(markdown);
    for (let i = 0; i < chunks.length; i += 1) {
        const withPrefix = i === 0 ? `${prefix}${chunks[i]}` : chunks[i]!;
        try {
            await api.sendRichMessage!(chatId, { markdown: withPrefix }, richOpts(opts));
        } catch {
            await sendHtmlFallback(api, chatId, chunks[i]!, opts, i === 0 ? prefix : '');
        }
    }
}

async function sendHtmlFallback(
    api: MaybeRichApi,
    chatId: string | number,
    mdChunk: string,
    opts: RichSendOpts | undefined,
    prefix: string,
): Promise<void> {
    const base = richOpts(opts);
    const htmlOpts = { ...base, parse_mode: 'HTML' as const };
    // Plaintext leg: omit the options object entirely when empty (legacy wire shape).
    const plainOpts = Object.keys(base).length > 0 ? base : undefined;
    const chunks = chunkTelegramMessage(markdownToTelegramHtml(mdChunk), HTML_MESSAGE_LIMIT);
    for (let i = 0; i < chunks.length; i += 1) {
        const withPrefix = i === 0 ? `${prefix}${chunks[i]}` : chunks[i]!;
        try {
            await api.sendMessage(chatId, withPrefix, htmlOpts);
        } catch {
            await api.sendMessage(chatId, withPrefix.replace(/<[^>]+>/g, ''), plainOpts);
        }
    }
}
