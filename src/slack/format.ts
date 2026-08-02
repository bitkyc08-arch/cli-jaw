// ─── Slack Message Formatting ────────────────────────
// CommonMark (what agents emit) -> mrkdwn (what Slack renders).
// Conversion rules verified against docs.slack.dev/messaging/formatting-message-text
// The order of operations matters: bold must be handled before italic, because
// '**x**' contains '*x*' as a substring.

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const STASH_MARK = '\u0000';

/** Protect code spans from formatting conversion, convert, then restore. */
function withCodeProtected(text: string, convert: (s: string) => string): string {
    const stash: string[] = [];
    const stashed = text
        .replace(CODE_FENCE, (m) => { stash.push(m); return `${STASH_MARK}${stash.length - 1}${STASH_MARK}`; })
        .replace(INLINE_CODE, (m) => { stash.push(m); return `${STASH_MARK}${stash.length - 1}${STASH_MARK}`; });
    const converted = convert(stashed);
    return converted.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)] ?? '');
}

export function toMrkdwn(text: string): string {
    if (!text) return '';
    return withCodeProtected(text, (s) => s
        // Links: [label](url) -> <url|label>
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
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
const FENCE_RESERVE = 4;

/**
 * Split for chat.postMessage.
 * Slack recommends staying under 4,000 chars and truncates above 40,000.
 * 3,900 leaves headroom for any prefix the caller adds.
 * Splits on newlines like chunkDiscordMessage, and never leaves a code fence
 * unterminated across a split — agent output is code-heavy.
 */
export function chunkSlackMessage(text: string, limit = 3900): string[] {
    if (text.length <= limit) return [text];
    // Reopening a fence prepends 4 chars to the remainder, so the cut window
    // must stay below the limit or the remainder never shrinks and the loop
    // spins forever. Guard the floor for very small limits too.
    const budget = Math.max(1, limit - FENCE_RESERVE);
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) { chunks.push(remaining); break; }
        // Prefer the last newline in the window, but only if it leaves a
        // substantial chunk. A newline near the start (e.g. right after a ```
        // fence opener) would emit a near-empty chunk and repeat forever.
        const MIN_FILL = Math.max(1, Math.floor(budget / 2));
        let cut = remaining.lastIndexOf('\n', budget);
        if (cut < MIN_FILL) cut = budget;
        const head = remaining.slice(0, cut);
        const fencesInHead = (head.match(/```/g) || []).length;
        // Each ``` toggles block state, and a reopened chunk already carries
        // its leading fence inside `head`, so the toggle count alone decides
        // whether this chunk ends mid-block.
        const endsInsideFence = fencesInHead % 2 === 1;
        chunks.push(endsInsideFence ? `${head}\n\`\`\`` : head);
        remaining = remaining.slice(cut).replace(/^\n/, '');
        if (endsInsideFence && remaining.length > 0) {
            remaining = `\`\`\`\n${remaining}`;
        }
    }
    return chunks;
}
