/**
 * src/browser/vision-input.ts — untrusted-input handling for the vision path.
 *
 * Kept separate from vision.ts so it can be tested without pulling in the CDP
 * action layer: these are pure functions over strings, and they guard the one
 * place where caller-supplied text reaches a child process.
 */

/**
 * The target description reaches the vision path from the HTTP body of
 * `POST /api/browser/vision-click` and is interpolated into a prompt for a
 * child process. Treat it as untrusted text, not as instructions.
 *
 * Be clear about what this is worth. The prompt's delimited span is a
 * model-behavior hint, not a security boundary; the instructions that follow
 * the span are what actually constrain the answer. This function's job is
 * narrower: keep the target on one line, stop it closing its own delimiter,
 * and bound its size. It does not, and cannot, stop the text from *reading*
 * like an instruction.
 */
export const MAX_TARGET_LENGTH = 200;

/**
 * Collapse every run of two or more double quotes to a single one.
 *
 * A single `replace(/"""/g, '"')` is not enough: `String.replace` scans left
 * to right without rescanning its own output, so `n` quotes become
 * `floor(n/3) + n%3`, and any `n >= 7` still leaves three in a row. Matching
 * runs of length two or more removes the whole class in one pass, so there is
 * no arity that survives.
 */
function collapseQuoteRuns(value: string): string {
    return value.replace(/"{2,}/g, '"');
}

/** Drop a trailing high surrogate so a truncated target stays well-formed. */
function trimLoneSurrogate(value: string): string {
    return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
}

export function sanitizeTarget(target: unknown): string {
    if (typeof target !== 'string') throw new Error('vision-click target must be a string');
    const cleaned = collapseQuoteRuns(
        target
            // C0 and C1 controls, plus the Unicode line and paragraph
            // separators, which JS \s also matches but which are line breaks
            // rather than ordinary whitespace and belong in this class.
            .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
            // Zero-width characters can split a token invisibly and pad length.
            .replace(/[\u200b-\u200f\u2060\ufeff]+/g, '')
            // Bidirectional overrides can reorder the value where it is echoed
            // back to a terminal.
            .replace(/[\u202a-\u202e\u2066-\u2069]+/g, ''),
    )
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) throw new Error('vision-click target is empty after sanitization');
    return cleaned.length > MAX_TARGET_LENGTH
        ? trimLoneSurrogate(cleaned.slice(0, MAX_TARGET_LENGTH))
        : cleaned;
}

/**
 * An agentic `codex exec` can emit command output, so its stdout is not
 * bounded by the answer we asked for. Keep the newest units: the coordinate
 * JSON arrives in a late event and the scan reads from the end, so a truncated
 * head line is expected garbage and the parser already skips it.
 *
 * This counts UTF-16 code units, not bytes — non-ASCII output can occupy up to
 * four bytes per unit, so treat it as an order-of-magnitude bound.
 */
export const MAX_CODEX_STDOUT_UNITS = 1024 * 1024;

/** @deprecated Misnamed: this bounds code units. Use MAX_CODEX_STDOUT_UNITS. */
export const MAX_CODEX_STDOUT_BYTES = MAX_CODEX_STDOUT_UNITS;

export function appendBounded(buffer: string, chunk: string, limit = MAX_CODEX_STDOUT_UNITS): string {
    const next = buffer + chunk;
    return next.length > limit ? next.slice(next.length - limit) : next;
}
