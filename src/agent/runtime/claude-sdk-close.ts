interface ClaudeCloseOptions {
    fence(): void;
    startTermination(): void;
    settlePending(): void;
    readerDone(): Promise<unknown>;
    timeoutMs: number;
    onClosed?(): void;
}

/** Stop admission synchronously; successful disposal requires the real exit barrier. */
export function createClaudeClose(options: ClaudeCloseOptions): () => Promise<void> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
        throw new Error('claude_invalid_close_timeout');
    }
    let closing: Promise<void> | undefined;
    return () => {
        if (closing) return closing;
        let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
        closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
        let failed = false;
        for (const action of [options.fence, options.startTermination, options.settlePending]) {
            try { action(); } catch { failed = true; }
        }
        void (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let timedOut = false;
            try {
                await Promise.race([Promise.resolve().then(options.readerDone), new Promise<never>((_, reject) => {
                    timer = setTimeout(() => { timedOut = true; reject(new Error('claude_close_timeout')); }, options.timeoutMs);
                })]);
                if (failed) throw new Error('claude_close_failed');
                options.onClosed?.();
            } catch {
                throw new Error(timedOut ? 'claude_close_timeout' : 'claude_close_failed');
            } finally { if (timer) clearTimeout(timer); }
        })().then(resolveClose, rejectClose);
        return closing;
    };
}
