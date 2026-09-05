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
import { closeAndReopen, fenceReserve, hasFence, safeCut, scanOpenFence, widestFenceOpener, type OpenFence } from '../messaging/chunk.js';
import { markdownToTelegramHtml, chunkTelegramMessage } from './forwarder.js';
import { redactOutboundText } from '../messaging/redact.js';
import { classifySendFailure, retryAfterMs, MAX_INLINE_RATE_LIMIT_MS } from '../messaging/retry.js';

export const RICH_MESSAGE_LIMIT = 32000;
const HTML_MESSAGE_LIMIT = 4096;

import { abortableDelay } from '../messaging/outbound-lifecycle.js';

/**
 * Send once, honouring what the failure actually was.
 *
 * The ladder used to catch everything, so a rate limit was answered by sending
 * the same content twice more, immediately — and a network failure that may
 * already have been accepted was answered by sending it again, which the user
 * sees twice.
 *
 * Returns true when the caller should fall back to a simpler format. Throws
 * when it should not: a long rate limit or an ambiguous failure is the
 * caller's to report, not to paper over with another send.
 */
async function attemptSend(send: () => Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
    try {
        await send();
        return false;
    } catch (err: unknown) {
        // A lifecycle abort is a cancellation, not a vendor failure: no
        // fallback leg, no retry — surface it to the caller as-is (#417).
        if (signal?.aborted) throw err;
        const kind = classifySendFailure(err);
        if (kind === 'format') return true;
        if (kind !== 'rate-limit') throw err;

        const wait = retryAfterMs(err);
        if (wait <= 0 || wait > MAX_INLINE_RATE_LIMIT_MS) throw err;
        // Abortable: a shutdown must not sit out a Telegram rate-limit window.
        await abortableDelay(wait, signal);
        if (signal?.aborted) throw err;

        // Retry the SAME form, once: waiting is what the server asked for, and
        // switching format would add load rather than remove it.
        try {
            await send();
            return false;
        } catch (retryErr: unknown) {
            if (classifySendFailure(retryErr) === 'format') return true;
            throw retryErr;
        }
    }
}

type MaybeRichApi = Pick<Api, 'sendMessage'> & Partial<Pick<Api, 'sendRichMessage'>>;

export interface RichSendOpts {
    /** Private native completion guard; not a Bot API option. */
    requireBodyDelivery?: boolean;
    /** Private receipt observer; never forwarded to the Bot API. */
    onBodyDelivered?: () => void;
    /** Invalidates a receipt when the legacy final-format failure is swallowed. */
    onBodyDeliveryFailed?: () => void;
    message_thread_id?: number;
    business_connection_id?: string;
    direct_messages_topic_id?: number;
    /** Prepended to the FIRST chunk only (e.g. '📡 '). */
    prefix?: string;
    /** Lifecycle cancellation (#417). Passed to grammY per call, exactly like
     *  the reaction path: the ipv4 fetch adapter destroys the request on abort. */
    signal?: AbortSignal;
}

/**
 * Outcome of a Telegram text send.
 *
 * Telegram was the one channel that signalled cancellation by throwing, while
 * `sendSlackText` and `sendDiscordTextRest` returned `ok: false`. That forced
 * every caller into a try/catch whose catch block could not tell "we cancelled
 * this" from "Telegram rejected it" without string-matching an Error message —
 * and the queue-notice path has to tell them apart, because a cancelled answer
 * must never close a notice as 'answered'.
 *
 * `aborted` is a separate flag rather than an error code so a caller can branch
 * on it without parsing text.
 */
export type TelegramSendResult =
    | { ok: true; aborted?: false }
    | { ok: false; aborted: true };

const OK: TelegramSendResult = { ok: true };
const ABORTED: TelegramSendResult = { ok: false, aborted: true };

/** True when the running grammy build exposes sendRichMessage (Bot API 10.1+). */
export function supportsRichMessage(api: MaybeRichApi): boolean {
    return typeof api.sendRichMessage === 'function';
}

/**
 * Split markdown on paragraph > line boundaries without breaking code fences.
 *
 * When a fence has no candidate boundary inside it — one long code block, the
 * common shape for agent output — the split lands mid-fence. Such a chunk is
 * closed here and the next one reopens with the same language tag, so both
 * render as code and keep their highlighting.
 */
export function chunkRichMarkdown(
    md: string,
    limit = RICH_MESSAGE_LIMIT,
    inherited: OpenFence | null = null,
): string[] {
    const raw = String(md || '');
    if (raw.length <= limit && !inherited) return [raw];

    // Reserve room for the reopener/closer only when a fence is actually in
    // play; otherwise the reserve costs an extra outbound message.
    //
    // The scan starts from the inherited fence: the remainder may close it and
    // then open a WIDER one, and sizing the reserve from the inherited fence
    // alone let that wider opener push a chunk past the limit.
    const worst = widestFenceOpener(raw, inherited);
    const fenced = inherited !== null || hasFence(raw);
    const wanted = fenced ? fenceReserve(worst.lang, worst.marker) : 0;
    // A delimiter can be wider than the whole budget — six backticks with a
    // long language tag is still a valid opener. Reserving for it left one
    // character of payload per chunk, so 400 characters became 406 messages.
    // Fall back to a bare fence, exactly as chunkFenceAware does; the marker
    // is then not reproduced, which costs formatting rather than delivery.
    const reserve = wanted < limit ? wanted : (fenced ? fenceReserve('') : 0);
    const budget = Math.max(1, limit - reserve);

    const pieces: string[] = [];
    let remaining = raw;
    while (remaining.length > budget) {
        // Guarantee progress. findMarkdownSafeSplit can return 0 — safeCut
        // refuses to divide a surrogate pair and backs off to the start when
        // the budget cannot hold one — and a zero-length cut never consumes
        // input, so the loop spins forever on a 43-character message.
        let cut = findMarkdownSafeSplit(remaining, budget);
        if (cut <= 0) cut = safeCut(remaining, Math.max(1, Math.min(budget, remaining.length)));
        if (cut <= 0) cut = Math.min(2, remaining.length);
        pieces.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
    }
    if (remaining.length > 0) pieces.push(remaining);

    // Pass the reserve as the ceiling: a marker wider than it would be
    // reproduced verbatim and carry the chunk past the caller's limit.
    return closeAndReopen(pieces, wanted < limit, inherited, reserve || undefined);
}

/**
 * Chunk so that the first chunk still fits once the prefix is prepended.
 * Only the first chunk carries the prefix, so only its budget is reduced.
 */
function chunkWithPrefixBudget(markdown: string, prefix: string, limit: number): string[] {
    if (!prefix) return chunkRichMarkdown(markdown, limit);
    const firstBudget = limit - prefix.length;
    if (firstBudget <= 0) return chunkRichMarkdown(markdown, limit);
    if (markdown.length <= firstBudget) return [markdown];

    // Decide the seam FIRST, then build both sides from it once. Re-chunking an
    // adjusted head discarded the closing fence the first pass had added, so
    // the head went out unclosed and the remainder carried a stray marker.
    const probe = chunkRichMarkdown(markdown, firstBudget);
    const rawConsumed = consumedLength(probe[0] ?? '', markdown);
    const consumed = avoidMidLineFenceHandoff(markdown, rawConsumed);
    if (consumed >= markdown.length) return [markdown];

    const headSource = markdown.slice(0, consumed);
    const rest = markdown.slice(consumed);
    const inherited = scanOpenFence(headSource);
    // One shared view of the fence state gives the head its closer and the
    // remainder its reopener.
    const head = closeAndReopen([headSource], true)[0] ?? headSource;
    return [head, ...chunkRichMarkdown(rest, limit, inherited)];
}

/**
 * A prefix at or past the limit leaves no room for content, and prepending it
 * anyway guarantees the API rejects the message. Drop it so the body still
 * gets delivered — every send path has to agree on this, or one of them ships
 * the oversized version.
 */
function effectivePrefix(prefix: string, limit: number, body = ''): string {
    if (!prefix) return '';
    // A fence must start its line. Prepending the prefix inline pushes an
    // opening fence off column zero, so Telegram stops seeing it as a fence
    // and the whole message renders as prose. Give the prefix its own line
    // whenever the body opens with a delimiter.
    const normalized = /^ {0,3}(?:`{3,}|~{3,})/.test(body) && !prefix.endsWith('\n')
        ? `${prefix}\n`
        : prefix;
    // Leave room for a whole code point, not just one code unit. With a single
    // unit of budget, safeCut refuses to split an astral character and emits
    // both halves, so prefix + payload lands one over the limit.
    const firstCodePoint = [...body][0] ?? '';
    const needed = Math.max(1, firstCodePoint.length);
    return normalized.length + needed <= limit ? normalized : '';
}

/**
 * A chunk boundary can turn a delimiter that sat MID-LINE in the source into
 * the first thing on a line of the next message, where Telegram reads it as a
 * fence. Back the split up to the last newline so the delimiter keeps the text
 * that preceded it on its line.
 *
 * Returns the adjusted consumed length, or the original when no adjustment is
 * possible (the whole head is one line — splitting it differently would not
 * help).
 */
function avoidMidLineFenceHandoff(source: string, consumed: number): number {
    const before = source.slice(0, consumed);
    // Only a mid-line delimiter is a problem: one that already started a line
    // in the source is meant to be a fence.
    if (before === '' || before.endsWith('\n')) return consumed;

    // Find where the delimiter run that touches the boundary begins. The
    // boundary may fall inside it, so scan back over the delimiter characters.
    let start = consumed;
    const delimiterAt = (i: number) => source[i] === '`' || source[i] === '~';
    while (start > 0 && delimiterAt(start - 1)) start -= 1;
    let end = start;
    while (end < source.length && delimiterAt(end)) end += 1;
    if (end - start < 3) return consumed;

    // Carry the code point before the run into the next message so the
    // delimiter is no longer the first thing on its line. It must be a whole
    // code point: moving one UTF-16 unit splits an emoji across the seam.
    if (start <= 0) return consumed;
    const prev = source.charCodeAt(start - 1);
    const isLowSurrogate = prev >= 0xDC00 && prev <= 0xDFFF;
    const step = isLowSurrogate && start >= 2 ? 2 : 1;
    return start - step;
}

/**
 * How much of `source` the emitted chunk consumed. The chunker may have added
 * a closing fence that is not part of the source, so a plain `.length` would
 * skip real content.
 */
function consumedLength(chunk: string, source: string): number {
    if (source.startsWith(chunk)) return chunk.length;
    const withoutClose = chunk.replace(/\n?(?:`{3,}|~{3,})$/, '');
    return source.startsWith(withoutClose) ? withoutClose.length : chunk.length;
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
    // Hard split as last resort — on a code-point boundary, so the cut never
    // separates a surrogate pair and never consumes zero input.
    return safeCut(raw, limit);
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

function requireTelegramBody(chunks: readonly string[], opts: RichSendOpts | undefined): void {
    if (!chunks.some(chunk => chunk.trim().length > 0)) {
        notifyBodyObserver(opts?.onBodyDeliveryFailed);
        if (opts?.requireBodyDelivery) {
            throw Object.assign(new Error('telegram_empty_message'), { code: 'empty_message', status: 400 });
        }
    }
}

function observeBodyDelivery(body: string, opts: RichSendOpts | undefined): void {
    if (!body.trim() || opts?.signal?.aborted || !opts?.onBodyDelivered) return;
    notifyBodyObserver(opts.onBodyDelivered);
}

function notifyBodyObserver(observer: (() => void) | undefined): void {
    if (!observer) return;
    // Receipt instrumentation cannot turn an accepted send into a retry/failure.
    try { void Promise.resolve(observer()).catch(() => {}); }
    catch { /* Observer failure never changes the legacy delivery outcome. */ }
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
 *
 * Cancellation is reported, not thrown (#417). A shutdown abort is an expected
 * outcome the caller asked for, so it comes back as `{ ok: false, aborted: true }`
 * the way Slack and Discord already report theirs. Vendor failures still throw:
 * collapsing the two would make a real delivery fault look like a clean stop.
 */
export async function sendTelegramMarkdown(
    api: MaybeRichApi,
    chatId: string | number,
    rawMarkdown: string,
    opts?: RichSendOpts,
): Promise<TelegramSendResult> {
    // Last mile for every Telegram text send: this helper is the single entry
    // point, so masking here cannot be bypassed by a caller that forgot.
    const markdown = redactOutboundText(rawMarkdown);
    const prefix = effectivePrefix(opts?.prefix ?? '', RICH_MESSAGE_LIMIT, markdown);
    if (!supportsRichMessage(api)) {
        return sendHtmlFallback(api, chatId, markdown, opts, prefix);
    }
    // The prefix rides on the first chunk, so it has to come out of that
    // chunk's budget. Chunking at the full limit and prepending afterwards
    // pushed the first message past the API limit and forced a needless
    // fallback.
    const chunks = chunkWithPrefixBudget(markdown, prefix, RICH_MESSAGE_LIMIT);
    requireTelegramBody(chunks, opts);
    for (let i = 0; i < chunks.length; i += 1) {
        if (opts?.signal?.aborted) return ABORTED;
        const withPrefix = i === 0 ? `${prefix}${chunks[i]}` : chunks[i]!;
        let needsFallback: boolean;
        try {
            needsFallback = await attemptSend(() =>
                // grammY's declared AbortSignal is the abort-controller shim type;
                // the reaction path (reactions.ts) uses the same `as never` cast.
                api.sendRichMessage!(chatId, { markdown: withPrefix }, richOpts(opts), opts?.signal as never), opts?.signal);
        } catch (err: unknown) {
            // attemptSend rethrows the vendor error as-is when the signal fired
            // mid-flight. The transport error is incidental there — what the
            // caller needs to know is that this turn was cancelled.
            if (opts?.signal?.aborted) return ABORTED;
            throw err;
        }
        if (needsFallback) {
            const fallback = await sendHtmlFallback(api, chatId, chunks[i]!, opts, i === 0 ? prefix : '');
            if (!fallback.ok) return fallback;
        } else observeBodyDelivery(withPrefix, opts);
    }
    return OK;
}

async function sendHtmlFallback(
    api: MaybeRichApi,
    chatId: string | number,
    mdChunk: string,
    opts: RichSendOpts | undefined,
    prefix: string,
): Promise<TelegramSendResult> {
    const base = richOpts(opts);
    const htmlOpts = { ...base, parse_mode: 'HTML' as const };
    // Plaintext leg: omit the options object entirely when empty (legacy wire shape).
    const plainOpts = Object.keys(base).length > 0 ? base : undefined;
    const html = markdownToTelegramHtml(mdChunk);
    const safePrefix = effectivePrefix(prefix, HTML_MESSAGE_LIMIT, html);
    const chunks = safePrefix
        ? chunkTelegramMessage(html, HTML_MESSAGE_LIMIT - safePrefix.length)
        : chunkTelegramMessage(html, HTML_MESSAGE_LIMIT);
    requireTelegramBody(chunks, opts);
    for (let i = 0; i < chunks.length; i += 1) {
        if (opts?.signal?.aborted) return ABORTED;
        const withPrefix = i === 0 ? `${safePrefix}${chunks[i]}` : chunks[i]!;
        try {
            const needsPlain = await attemptSend(
                () => api.sendMessage(chatId, withPrefix, htmlOpts, opts?.signal as never), opts?.signal);
            if (needsPlain) {
                const plain = withPrefix.replace(/<[^>]+>/g, '');
                requireTelegramBody([plain], opts);
                let plainFailure: unknown;
                const plainFailedFormat = await attemptSend(async () => {
                    try { return await api.sendMessage(chatId, plain, plainOpts, opts?.signal as never); }
                    catch (error) { plainFailure = error; throw error; }
                }, opts?.signal);
                if (plainFailedFormat) {
                    notifyBodyObserver(opts?.onBodyDeliveryFailed);
                    if (opts?.requireBodyDelivery) throw plainFailure;
                } else observeBodyDelivery(plain, opts);
            } else observeBodyDelivery(withPrefix, opts);
        } catch (err: unknown) {
            if (opts?.signal?.aborted) return ABORTED;
            throw err;
        }
    }
    return OK;
}
