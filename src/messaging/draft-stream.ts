export interface DraftTransport {
    post(text: string): Promise<string | null>;
    edit(handle: string, text: string): Promise<void>;
    remove(handle: string): Promise<void>;
}

export interface DraftStreamOptions {
    readonly minEditIntervalMs: number;
    readonly maxChars: number;
    readonly now?: () => number;
    readonly setTimer?: typeof setTimeout;
    readonly clearTimer?: typeof clearTimeout;
    readonly onError?: (operation: 'post' | 'edit' | 'remove', error: unknown) => void;
}

export interface DraftStream {
    /** Latest-wins, rate-limited, best-effort update. */
    update(text: string): void;
    /** Force final text now. False means the caller must use its existing send path. */
    finalize(text: string): Promise<boolean>;
    /** Remove an unpublished draft; idempotent. */
    discard(): Promise<void>;
    /** Opaque transport handle, or null after failed post/removal. */
    handle(): string | null;
}

type StreamState = 'active' | 'finalizing' | 'finalized' | 'discarded';
type DraftOperation = 'post' | 'edit' | 'remove';

export async function startDraftStream(
    transport: DraftTransport,
    initialText: string,
    options: DraftStreamOptions,
): Promise<DraftStream> {
    const now = options.now ?? Date.now;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const report = (operation: DraftOperation, error: unknown): void => {
        try {
            options.onError?.(operation, error);
        } catch {
            // Diagnostics are best-effort too.
        }
    };

    let draftHandle: string | null = null;
    let state: StreamState = 'active';
    let lastSentText: string | null = null;
    // Match Slack's current behavior: the first update is immediately eligible.
    let lastEditAt = now() - options.minEditIntervalMs;
    let pendingText: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<boolean> | null = null;
    let terminalOperation: Promise<boolean> | null = null;

    try {
        draftHandle = await transport.post(initialText);
        if (draftHandle) lastSentText = initialText;
    } catch (error) {
        report('post', error);
        draftHandle = null;
    }

    const clearScheduledFlush = (): void => {
        if (!timer) return;
        clearTimer(timer);
        timer = null;
    };

    const removeDraft = async (): Promise<void> => {
        const handle = draftHandle;
        draftHandle = null;
        pendingText = null;
        if (!handle) return;
        try {
            await transport.remove(handle);
        } catch (error) {
            report('remove', error);
        }
    };

    const editText = async (text: string): Promise<boolean> => {
        const handle = draftHandle;
        if (!handle) return false;
        if (text === lastSentText) return true;
        // Failed attempts are rate-limited too, preventing a tight retry loop.
        lastEditAt = now();
        try {
            await transport.edit(handle, text);
            lastSentText = text;
            return true;
        } catch (error) {
            report('edit', error);
            return false;
        }
    };

    const flushPending = async (): Promise<boolean> => {
        if (state !== 'active' || !draftHandle || pendingText === null) return false;
        const text = pendingText;
        pendingText = null;
        const operation = editText(text);
        inFlight = operation;
        try {
            return await operation;
        } finally {
            if (inFlight === operation) inFlight = null;
        }
    };

    const schedule = (): void => {
        if (state !== 'active' || !draftHandle || pendingText === null || timer || inFlight) return;
        const waitMs = Math.max(0, options.minEditIntervalMs - (now() - lastEditAt));
        timer = setTimer(() => {
            timer = null;
            void flushPending().finally(() => schedule());
        }, waitMs);
        timer.unref?.();
    };

    return {
        update(text: string): void {
            if (state !== 'active' || !draftHandle || !text) return;
            if (text === pendingText || (pendingText === null && text === lastSentText)) return;
            pendingText = text;
            schedule();
        },

        async finalize(text: string): Promise<boolean> {
            if (state === 'finalized') return true;
            if (state === 'discarded' || !draftHandle) return false;
            if (terminalOperation) return await terminalOperation;

            state = 'finalizing';
            terminalOperation = (async () => {
                clearScheduledFlush();
                if (inFlight) await inFlight;
                if (!draftHandle) {
                    state = 'discarded';
                    return false;
                }

                pendingText = null;
                if (text.length > options.maxChars) {
                    state = 'discarded';
                    await removeDraft();
                    return false;
                }

                // Finalization deliberately bypasses the edit interval.
                const committed = await editText(text);
                if (committed) {
                    state = 'finalized';
                    return true;
                }

                state = 'discarded';
                await removeDraft();
                return false;
            })();
            return await terminalOperation;
        },

        async discard(): Promise<void> {
            if (state === 'discarded' || state === 'finalized') return;
            if (terminalOperation) {
                await terminalOperation;
                return;
            }
            state = 'discarded';
            clearScheduledFlush();
            if (inFlight) await inFlight;
            await removeDraft();
        },

        handle(): string | null {
            return draftHandle;
        },
    };
}
