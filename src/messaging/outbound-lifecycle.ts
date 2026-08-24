// ─── Outbound send lifecycle (#417) ──────────────────
// Shutdown could always cancel the queue-notice cleanup (QueueNoticeRegistry),
// but the ANSWER itself — body sends, chunk retry sleeps, file/image uploads —
// ran outside any registry: no signal reached the vendor call, so the process
// exit left sockets and uploads running (Slack), waited out grammY's 500s API
// timeout (Telegram), or hung on discord.js channel.send.
//
// This registry is the missing half. Each outbound turn takes a scoped
// AbortSignal from start() and releases it with done() when the send settles;
// shutdown calls drain(), which aborts every in-flight controller and waits a
// bounded moment for handlers to observe the abort. The signal reaching the
// actual HTTP layer is each channel's own plumbing job.
//
// Contract notes (from the #417 review):
//  - An abort is NOT a vendor failure. Callers must report cancelled sends as
//    cancelled (or ambiguous), never as a definitive vendor rejection.
//  - A cancelled answer send must never close a queue notice as 'answered'.

export type OutboundSendScope = {
    /** Abort signal for every vendor call this outbound turn makes. */
    readonly signal: AbortSignal;
    /** Release the scope. Idempotent. Call when the send settles either way. */
    done(): void;
};

export class OutboundSendRegistry {
    private readonly entries = new Set<AbortController>();

    /** Number of in-flight outbound scopes (test/diagnostic surface). */
    get size(): number { return this.entries.size; }

    /**
     * Open a scope for one outbound turn.
     *
     * An optional parent signal (per-request ingress abort, caller timeout) is
     * composed in: aborting the parent aborts this scope, without the parent
     * needing to know the registry exists.
     */
    start(parent?: AbortSignal): OutboundSendScope {
        const controller = new AbortController();
        const entries = this.entries;
        let onParent: (() => void) | undefined;
        if (parent) {
            if (parent.aborted) controller.abort(parent.reason);
            else {
                onParent = () => controller.abort(parent.reason);
                parent.addEventListener('abort', onParent, { once: true });
            }
        }
        entries.add(controller);
        let released = false;
        return {
            signal: controller.signal,
            done() {
                if (released) return;
                released = true;
                if (parent && onParent) parent.removeEventListener('abort', onParent);
                entries.delete(controller);
            },
        };
    }

    /**
     * Abort every in-flight scope, then give handlers a bounded moment to
     * observe the abort before shutdown proceeds.
     *
     * Unlike QueueNoticeRegistry.drain this aborts FIRST: the goal is not to
     * finish the sends (they are being cancelled) but to make sure the
     * underlying requests are torn down before the process exits.
     */
    async drain(graceMs = 250): Promise<void> {
        const pending = [...this.entries];
        this.entries.clear();
        if (!pending.length) return;
        for (const controller of pending) controller.abort(new Error('outbound_shutdown'));
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, graceMs);
            (timer as { unref?: () => void }).unref?.();
        });
    }
}

/** Sleep that a shutdown abort can cut short. Resolves (never rejects) on
 *  abort so retry loops fall through to their own signal checks. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
