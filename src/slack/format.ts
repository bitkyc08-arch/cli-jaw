// ─── Slack Message Formatting ────────────────────────
// CommonMark (what agents emit) -> mrkdwn (what Slack renders).
// Conversion rules verified against docs.slack.dev/messaging/formatting-message-text
// The order of operations matters: bold must be handled before italic, because
// '**x**' contains '*x*' as a substring.

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
// Sentinel for stashed code spans. It must not occur in the input, so any
// literal occurrence is stripped first — otherwise text like "a\u00000\u0000b"
// would be mistaken for a stash reference and silently eat content.
const STASH_MARK = '\u0000';

/** Protect code spans from formatting conversion, convert, then restore. */
function withCodeProtected(text: string, convert: (s: string) => string): string {
    const stash: string[] = [];
    const stashed = text
        .replaceAll(STASH_MARK, '')
        .replace(CODE_FENCE, (m) => { stash.push(m); return `${STASH_MARK}${stash.length - 1}${STASH_MARK}`; })
        .replace(INLINE_CODE, (m) => { stash.push(m); return `${STASH_MARK}${stash.length - 1}${STASH_MARK}`; });
    const converted = convert(stashed);
    return converted.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)] ?? '');
}

export function toMrkdwn(text: string): string {
    if (!text) return '';
    return withCodeProtected(text, (s) => s
        // Links: [label](url) -> <url|label>. The label may contain balanced
        // brackets (common in agent output: "[see [1]](url)").
        .replace(/\[((?:[^\][]|\[[^\][]*\])+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        // Bold+italic first: ***x*** -> *_x_* (Slack has no combined marker).
        .replace(/\*\*\*([^*\n]+)\*\*\*/g, '*_$1_*')
        // Bold: **x** or __x__ -> *x*   (before italic)
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/__([^_\n]+)__/g, '*$1*')
        // Strikethrough: ~~x~~ -> ~x~
        .replace(/~~([^~\n]+)~~/g, '~$1~')
        // Headings: '## Title' -> '*Title*' (mrkdwn has no heading syntax)
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*'),
    ).replace(/```[a-zA-Z0-9_+-]+\n/g, '```\n'); // fence language tags are unsupported
}

/** Reserved for the ``` we may append/prepend when a split lands inside a fence. */
const FENCE_RESERVE = 8; // "```\n" prepended + "\n```" appended
/** Below this, fence-aware wrapping cannot fit; fall back to a plain split. */
const MIN_FENCE_AWARE_LIMIT = 24;

/**
 * Split at a code-point boundary so a cut never separates a surrogate pair.
 * When backing off would produce an empty chunk (a limit so small that a
 * single astral character does not fit), advance instead: emitting one
 * slightly oversized chunk is better than shipping half an emoji, and better
 * than looping forever on a zero-length cut.
 */
function safeCut(text: string, index: number): number {
    if (index >= text.length) return text.length;
    const code = text.charCodeAt(index);
    const splitsPair = code >= 0xDC00 && code <= 0xDFFF;
    if (!splitsPair) return index;
    return index > 1 ? index - 1 : index + 1;
}

/**
 * Split text into chunks of at most `limit` characters WITHOUT losing content.
 * Prefers newline boundaries; the newline stays with the preceding chunk so
 * chunks concatenate back to the input exactly.
 */
function splitPreservingContent(text: string, limit: number): string[] {
    const out: string[] = [];
    let rest = text;
    while (rest.length > limit) {
        // Keep the newline in this chunk (+1) rather than dropping it.
        const nl = rest.lastIndexOf('\n', limit - 1);
        let cut = nl > 0 ? nl + 1 : safeCut(rest, limit);
        // A zero cut would never consume input. Take one whole code point.
        if (cut <= 0) cut = safeCut(rest, Math.max(1, Math.min(limit, rest.length)));
        if (cut <= 0) cut = Math.min(2, rest.length);
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest.length > 0) out.push(rest);
    return out;
}

/**
 * Split for chat.postMessage.
 * Slack recommends staying under 4,000 chars and truncates above 40,000.
 * 3,900 leaves headroom for any prefix the caller adds.
 *
 * Content is never lost: chunks concatenate back to the input apart from the
 * ``` markers injected to keep each chunk's code block closed. Agent output is
 * code-heavy, so a split inside a fence would render the remainder as prose.
 */
export function chunkSlackMessage(text: string, limit = 3900): string[] {
    if (!text) return [text];
    const cap = Math.max(1, Math.floor(limit));
    if (text.length <= cap) return [text];

    // Too small to wrap anything in fences — split plainly rather than spin.
    if (cap < MIN_FENCE_AWARE_LIMIT) return splitPreservingContent(text, cap);

    // Every piece is produced from the ORIGINAL text and strictly consumes it,
    // so termination does not depend on how many fences we inject afterwards.
    const rawPieces = splitPreservingContent(text, cap - FENCE_RESERVE);

    // A piece holding only fence markers and whitespace would post as an empty
    // code block. MERGE it forward into the next piece rather than dropping it
    // — skipping it silently deleted the source's own blank lines.
    // Merging must not push a piece past the budget, or the injected fences
    // would carry it over the caller's limit.
    const budget = cap - FENCE_RESERVE;
    const pieces: string[] = [];
    let carry = '';
    for (const piece of rawPieces) {
        const candidate = carry + piece;
        if (candidate.length > budget) {
            // Cannot merge without overflowing: emit what we have separately.
            if (carry) pieces.push(carry);
            pieces.push(piece);
            carry = '';
            continue;
        }
        if (candidate.replace(/```/g, '').trim() === '') {
            carry = candidate;
            continue;
        }
        pieces.push(candidate);
        carry = '';
    }
    if (carry) {
        const last = pieces[pieces.length - 1];
        if (last !== undefined && last.length + carry.length <= budget) {
            pieces[pieces.length - 1] = last + carry;
        } else {
            pieces.push(carry);
        }
    }

    const out: string[] = [];
    let openFence: boolean = false;
    for (const piece of pieces) {
        const opened: boolean = openFence;
        const fences = (piece.match(/```/g) || []).length;
        const closesOpen: boolean = opened !== (fences % 2 === 1);
        let chunk = piece;
        if (opened) chunk = `\`\`\`\n${chunk}`;
        if (closesOpen) chunk = `${chunk.replace(/\n$/, '')}\n\`\`\``;
        out.push(chunk);
        openFence = closesOpen;
    }
    return out.length > 0 ? out : [text];
}
