// CF-3 — a repeated history cursor is no-progress, not a legitimate page
// boundary. The pagination contract is exclusive `id < before`, so a server
// that repeats (or advances) the cursor can never terminate loadOlder; the
// controller must detect that and mark exhausted instead of looping forever.
// Extracted so the decision is unit-testable.

export interface HistoryPageProgress {
    cursorAdvanced: boolean;
    noProgress: boolean;
}

export function evaluateHistoryPageProgress(
    previousCursor: number | null,
    nextCursor: number | null,
): HistoryPageProgress {
    const cursorAdvanced = nextCursor !== previousCursor
        && (previousCursor === null
            || (nextCursor !== null && nextCursor < previousCursor));
    return {
        cursorAdvanced,
        noProgress: previousCursor !== null && !cursorAdvanced,
    };
}
