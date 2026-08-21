// ─── Queue Notice Lifecycle ──────────────────────────
// The "added to queue" message is a promise to the user, and a promise has to
// be closed out. Three transports each hand-rolled this and each got it wrong
// in a different way, so the lifecycle lives here and the transports supply
// only two verbs.
//
// The hard part is not deletion, it is ORDERING. The notice is posted with an
// await, and the queued job can settle during that await — so cleanup routinely
// runs before there is anything to clean up. Storing the outcome and draining it
// when the handle lands is the only shape that survives that race.

/**
 * Why the notice is being closed out.
 *
 * - `answered`: the reply is in the channel, so the notice is now noise -> delete.
 * - `expired`:  no reply ever came (timeout, shutdown, or a failed send). Deleting
 *               would erase every trace of the turn, so rewrite it instead.
 */
export type NoticeOutcome = 'answered' | 'expired';

/**
 * What a transport must supply.
 *
 * Both MUST reject on vendor failure, the same contract AckTransport carries:
 * Slack's slackApi resolves with {ok:false} rather than throwing, and a silent
 * failure here is exactly the stale notice this module exists to prevent.
 *
 * The signal is the deadline from a registry drain. Honouring it is what makes
 * a bounded shutdown real rather than cosmetic — a transport that ignores it
 * leaves the request running after drain() has already returned.
 */
export type NoticeTransport = {
    delete(signal?: AbortSignal): Promise<void>;
    edit(text: string, signal?: AbortSignal): Promise<void>;
};

export type QueueNoticeHandle = {
    /** Bind the transport once the post resolves. Drains an outcome that arrived
     *  while the post was still in flight. Ignored after abandon(), and ignored
     *  on a second call — one notice has one handle. */
    bind(transport: NoticeTransport): void;
    /** Close the notice out. Idempotent; the FIRST outcome wins and every caller
     *  receives the same completion, which resolves only once the vendor work is
     *  actually done. */
    close(outcome: NoticeOutcome, signal?: AbortSignal): Promise<void>;
    /** No handle will ever arrive (the post failed). Resolves any pending close
     *  so a registry drain cannot wait out its whole deadline for a message that
     *  does not exist. */
    abandon(): void;
    readonly closed: boolean;
};

export type QueueNoticeOptions = {
    /** Text for the `expired` rewrite. Resolved by the caller so this module
     *  stays free of i18n wiring. */
    readonly expiredText: string;
    readonly onError?: (error: unknown) => void;
};

export function createQueueNotice(options: QueueNoticeOptions): QueueNoticeHandle {
    let transport: NoticeTransport | null = null;
    let pendingOutcome: NoticeOutcome | null = null;
    let pendingSignal: AbortSignal | undefined;
    let closed = false;
    let bound = false;
    let abandoned = false;
    // One completion shared by every close() caller. It resolves when the vendor
    // work finishes — including work that could only start once a late bind()
    // supplied the handle. A close() that resolved before that would let a
    // registry drain tear the transport down mid-request.
    let settleCompletion: (() => void) | null = null;
    let completion: Promise<void> | null = null;

    const swallow = (error: unknown) => { options.onError?.(error); };

    const ensureCompletion = (): Promise<void> => {
        if (!completion) {
            completion = new Promise<void>((resolve) => { settleCompletion = resolve; });
        }
        return completion;
    };

    const finish = (): void => {
        const resolve = settleCompletion;
        settleCompletion = null;
        resolve?.();
    };

    const apply = async (outcome: NoticeOutcome, signal?: AbortSignal): Promise<void> => {
        const active = transport;
        // Null it first: a second close must not re-issue a vendor call even while
        // the first one is still awaiting.
        transport = null;
        if (!active) { finish(); return; }
        try {
            if (outcome === 'answered') await active.delete(signal);
            else await active.edit(options.expiredText, signal);
        } catch (error) {
            swallow(error);
        } finally {
            finish();
        }
    };

    return {
        get closed() { return closed; },
        bind(next) {
            // A notice has exactly one handle. A second bind would let a stale
            // transport be closed twice, and after abandon() there is nothing left
            // to act on — both are unconditional ignores, never a guessed outcome.
            if (abandoned || bound) return;
            bound = true;
            transport = next;
            if (!closed) return;
            // Closed while the post was in flight: the outcome is already known, so
            // honour THAT one rather than assuming the notice was answered.
            const outcome = pendingOutcome;
            pendingOutcome = null;
            const signal = pendingSignal;
            pendingSignal = undefined;
            if (!outcome) { finish(); return; }
            void apply(outcome, signal).catch(swallow);
        },
        close(outcome, signal) {
            if (closed) return ensureCompletion();
            closed = true;
            const done = ensureCompletion();
            if (abandoned) { finish(); return done; }
            if (!transport) {
                // Nothing to act on yet; bind() will drain this.
                pendingOutcome = outcome;
                pendingSignal = signal;
                return done;
            }
            void apply(outcome, signal).catch(swallow);
            return done;
        },
        abandon() {
            if (abandoned) return;
            abandoned = true;
            pendingOutcome = null;
            pendingSignal = undefined;
            transport = null;
            // Resolve whatever close() handed out, and pre-arm the completion so a
            // later close() does not wait for a handle that will never arrive.
            ensureCompletion();
            finish();
        },
    };
}

// ─── Shutdown registry ───────────────────────────────
// Slack and Discord kept sets of teardown callbacks and called them
// fire-and-forget; Telegram had no registry at all. Both shapes lose the
// rewrite: the process exits before the API call goes out.

export type NoticeTeardown = (signal?: AbortSignal) => Promise<void>;

export class QueueNoticeRegistry {
    private readonly entries = new Set<NoticeTeardown>();

    /** Returns its own unregister so a normally-completed turn can drop out
     *  instead of lingering until the next drain. */
    add(teardown: NoticeTeardown): () => void {
        this.entries.add(teardown);
        return () => { this.entries.delete(teardown); };
    }

    get size(): number { return this.entries.size; }

    /**
     * Run every teardown, bounded, then abort whatever is still running.
     *
     * The bound is not decoration: grammY's client defaults to a 500s API timeout
     * and this repo's Telegram fetch adapter wires no signal, so an unbounded
     * await here could hold shutdown for minutes. A notice we failed to rewrite is
     * a cosmetic loss; a shutdown that never finishes is not.
     *
     * Racing the deadline only stops WAITING, so the signal is what actually
     * cancels. Transports that honour it end their request; the per-adapter proof
     * of that belongs to each channel's own phase.
     */
    async drain(timeoutMs = 3000): Promise<void> {
        const pending = [...this.entries];
        // Cleared before awaiting: a teardown runs at most once per drain even if
        // shutdown is re-entered.
        this.entries.clear();
        if (!pending.length) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(() => { controller.abort(); resolve(); }, timeoutMs);
        });
        try {
            // Promise.resolve().then(fn) rather than fn(): a teardown that throws
            // SYNCHRONOUSLY would otherwise escape before allSettled ever sees it,
            // rejecting drain() with the entries already cleared.
            const running = pending.map(fn => Promise.resolve().then(() => fn(controller.signal)));
            await Promise.race([
                Promise.allSettled(running).then(() => undefined),
                deadline,
            ]);
        } finally {
            if (timer) clearTimeout(timer);
            controller.abort();
        }
    }
}
