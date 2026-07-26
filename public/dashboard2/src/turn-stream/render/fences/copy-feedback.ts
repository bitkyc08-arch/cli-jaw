// CF-6 — a clipboard failure must surface to the user, not vanish into an
// unhandled rejection. This helper converts a copy attempt into a result the
// caller renders (alert/notice). Extracted so the surfacing is unit-testable.

export type CopyOutcome = { ok: true } | { ok: false; message: string };

export async function copyWithFeedback(
    copyText: (text: string) => Promise<unknown>,
    text: string,
): Promise<CopyOutcome> {
    try {
        await copyText(text);
        return { ok: true };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
