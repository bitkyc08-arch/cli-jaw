/**
 * Safety bound for `ctx.fullText` accumulation (260803 unit, 030 phase D3).
 *
 * `fullText` is not just display text — goal control-flow regexes, session-id
 * extraction, and smoke/stale detection all read the WHOLE string. So the
 * 200k cap used for the live-run mirror (src/agent/live-run-state.ts) is the
 * wrong number to copy here; clipping that aggressively would silently break
 * goal markers. Match the agy path's 8 MiB bound instead, which was chosen for
 * exactly this reason (src/agent/agy-runtime.ts AGY_FULLTEXT_MAX_CHARS).
 *
 * A run holding 8 MiB is a spike, not a leak — `ctx` is released at run end —
 * but before this bound a 50 MB response held 50 MB until completion.
 */
export const FULLTEXT_MAX_CHARS = 8_388_608;

/**
 * Append with a hard bound. Returns the text to store. The caller is expected
 * to set `fullTextTruncated` when this returns a shortened result so that
 * finalization can note the elision rather than silently shipping a clipped
 * answer.
 */
export function appendBoundedFullText(current: string, segment: string): { text: string; truncated: boolean } {
    // Callers reach here from partially-initialized contexts where fullText may
    // not be set yet; treat that as empty rather than throwing on a hot path.
    const base = current ?? '';
    if (base.length >= FULLTEXT_MAX_CHARS) return { text: base, truncated: true };
    const remaining = FULLTEXT_MAX_CHARS - base.length;
    if (segment.length <= remaining) return { text: base + segment, truncated: false };
    return { text: base + segment.slice(0, remaining), truncated: true };
}
