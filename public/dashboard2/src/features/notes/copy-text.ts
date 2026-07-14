export async function copyText(text: string): Promise<{ ok: boolean; error?: string }> {
    try {
        await navigator.clipboard.writeText(text);
        return { ok: true };
    } catch (copyError) {
        return {
            ok: false,
            error: copyError instanceof Error ? copyError.message : 'Unable to copy text',
        };
    }
}
