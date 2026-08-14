// ─── Slack Message Formatting ────────────────────────
// CommonMark (what agents emit) -> mrkdwn (what Slack renders).
// Conversion rules verified against docs.slack.dev/messaging/formatting-message-text
// The order of operations matters: bold must be handled before italic, because
// '**x**' contains '*x*' as a substring.

import { chunkFenceAware } from '../messaging/chunk.js';
import { redactOutboundText } from '../messaging/redact.js';

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
/**
 * Split for chat.postMessage.
 * Slack recommends staying under 4,000 chars and truncates above 40,000.
 * 3,900 leaves headroom for any prefix the caller adds.
 *
 * Delegates to the shared splitter. Slack never sees a fence language tag:
 * `toMrkdwn` strips it above, because mrkdwn does not render one. The shared
 * splitter preserves tags it finds but never invents one, so that contract
 * holds.
 *
 * Redaction happens here, as it does for Discord: every outbound Slack text
 * passes through this function, so there is one place to audit.
 */
/** Slack's practical per-message ceiling. Exported so the capability declaration is
 *  derived from the limit that actually chunks, not a second copy of the number. */
export const SLACK_MESSAGE_LIMIT = 3900;

export function chunkSlackMessage(text: string, limit = SLACK_MESSAGE_LIMIT): string[] {
    return chunkFenceAware(redactOutboundText(text), limit);
}
