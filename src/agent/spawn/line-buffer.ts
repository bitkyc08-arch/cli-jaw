/**
 * Guard against a newline-free stdout stream growing a line buffer without limit.
 *
 * NDJSON readers keep the trailing partial line in memory until a newline
 * arrives. A child that never emits one — a progress bar redrawing with \r,
 * binary data on stdout, a truncated JSON stream — makes that buffer grow for
 * the lifetime of the process. Measured: 200 MiB of newline-free output pushed
 * the heap past 1.5 GiB, because each append reallocates the whole string.
 *
 * The cap is generous enough that a legitimately long JSON line still parses,
 * and it is only reached when no newline has been seen at all.
 */
export const MAX_PENDING_LINE_CHARS = 8 * 1024 * 1024;

export interface PendingLineResult {
    /** The pending line to keep, truncated when it exceeded the cap. */
    buffer: string;
    /** True when this call dropped data. */
    overflowed: boolean;
}

/**
 * Clamp a pending (newline-free) line buffer.
 *
 * Keeps the HEAD rather than the tail: for a stream that never terminates a
 * line, the beginning is what identifies the malformed payload, and discarding
 * the head would leave an unparseable fragment either way.
 */
export function clampPendingLine(
    buffer: string,
    maxChars: number = MAX_PENDING_LINE_CHARS,
): PendingLineResult {
    if (buffer.length <= maxChars) return { buffer, overflowed: false };
    return { buffer: buffer.slice(0, maxChars), overflowed: true };
}
