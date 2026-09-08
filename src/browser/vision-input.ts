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
 * The cap is a denial-of-service bound rather than a security boundary: a
 * caller cannot force an unbounded prompt. Stripping control characters keeps
 * the target on one line so it cannot forge the surrounding prompt structure,
 * and removing the delimiter stops it closing its own quoted span.
 */
export const MAX_TARGET_LENGTH = 200;

export function sanitizeTarget(target: unknown): string {
    if (typeof target !== 'string') throw new Error('vision-click target must be a string');
    const cleaned = target
        // C0 and C1 control characters, including newline and tab.
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
        // The prompt wraps the target in triple quotes; it must not contain them.
        .replace(/"""/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) throw new Error('vision-click target is empty after sanitization');
    return cleaned.length > MAX_TARGET_LENGTH ? cleaned.slice(0, MAX_TARGET_LENGTH) : cleaned;
}

/**
 * An agentic `codex exec` can emit command output, so its stdout is not
 * bounded by the answer we asked for. Keep the newest bytes: the coordinate
 * JSON arrives in a late event and the scan reads from the end.
 */
export const MAX_CODEX_STDOUT_BYTES = 1024 * 1024;

export function appendBounded(buffer: string, chunk: string, limit = MAX_CODEX_STDOUT_BYTES): string {
    const next = buffer + chunk;
    return next.length > limit ? next.slice(next.length - limit) : next;
}

