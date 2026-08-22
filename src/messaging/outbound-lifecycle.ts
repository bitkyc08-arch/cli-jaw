// ─── Outbound turn lifecycle ─────────────────────────
// Shutdown could already bound the queue NOTICE cleanup (QueueNoticeRegistry).
// It could not bound the thing the user is actually waiting for: the answer body,
// the rate-limit sleep in front of it, and the image upload behind it. Those had
// no owner, so a restart left them running against a transport that was gone.
//
// Why a second registry rather than reusing the notice one: the notice registry
// holds TEARDOWNS (work that starts when shutdown begins). This holds LIVE TURNS
// (work already in flight that shutdown must cancel). Draining the first starts
// work; draining this one stops it. Folding them together would make "drain"
// mean both, and the ordering between them is load-bearing.
//
// Registration covers all three paths deliberately. Wiring only the queued branch
// is the mistake this module exists to prevent: the ordinary reply path and the
// boot-drain forwarder are detached promises that shutdown never even sees.

import type { MessengerChannel } from './types.js';
import type { OutboundAttemptState } from './outbound-outbox.js';

/** Which outbound path a turn belongs to. Only used for diagnostics today, but a
 *  registry that cannot say WHICH path leaked is not much of an answer. */
export type OutboundPath = 'normal' | 'queued' | 'forwarder';

/**
 * The reason a turn's signal carries when shutdown is what cancelled it.
 *
 * A distinct object rather than a string: `AbortSignal.reason` is compared by
 * identity here, and a bare string would collide with a vendor error that happens
 * to carry the same text.
 */
export const SHUTDOWN_ABORT_REASON: unique symbol = Symbol('outbound_shutdown');

export type AbortClass = 'shutdown' | 'vendor';

export function isShutdownAbort(reason: unknown): boolean {
    return reason === SHUTDOWN_ABORT_REASON;
}

/**
 * Why the work stopped.
 *
 * The distinction is not cosmetic. A shutdown cancel is expected and must not be
 * logged as a delivery failure or retried; a vendor abort is a real fault that
 * has to stay visible. Collapsing them is how a cancelled send becomes a silent
 * error, or an error becomes a silent cancel.
 */
export function classifyAbort(reason: unknown): AbortClass {
    return isShutdownAbort(reason) ? 'shutdown' : 'vendor';
}

/**
 * How an aborted send should settle in `outbound_attempts`.
 *
 * Without this the cancellation work introduces a new leak: a turn aborted
 * mid-send leaves its row in `sending` forever, which blocks the ingress
 * retention sweep and looks to an operator like a request still on the wire.
 *
 * The split is about what the vendor could have seen, NOT about who cancelled:
 *
 * - `sending` -> `ambiguous`. The bytes left the process. Nobody can say whether
 *   they were processed, and `ambiguous` is exactly that statement. Calling it a
 *   definitive failure would invite a replay to deliver the message twice.
 * - `pending` -> `definitive_failed`. Nothing was dispatched, so no duplicate is
 *   possible and doubt would be manufactured.
 * - terminal states -> null. A late abort must not rewrite an outcome that is
 *   already known.
 */
export function outboxOutcomeForAbort(attempt: {
    state: OutboundAttemptState;
    reason: unknown;
}): 'ambiguous' | 'definitive_failed' | null {
    if (attempt.state === 'sending') return 'ambiguous';
    if (attempt.state === 'pending') return 'definitive_failed';
    return null;
}

export type OutboundTurnOptions = {
    readonly channel: MessengerChannel;
    readonly path: OutboundPath;
    /** Upstream cancellation (an existing per-request signal), composed in. */
    readonly signal?: AbortSignal;
    /**
     * Abort the whole turn after this long, drain or no drain.
     *
     * A per-call timeout cannot say "this entire turn stopped mattering" — it
     * bounds one HTTP request, so a chunk loop of ten sends can outlive ten
     * timeouts and still be running.
     */
    readonly totalDeadlineMs?: number;
};

export type OutboundTurn = {
    readonly channel: MessengerChannel;
    readonly path: OutboundPath;
    /** Pass this into every vendor call the turn makes. */
    readonly signal: AbortSignal;
    /**
     * Let a drain WAIT for this work before it aborts.
     *
     * Without it a drain can only abort blindly at time zero; with it, work that
     * would have finished in 200ms is allowed to.
     */
    track(work: Promise<unknown>): void;
    /** Cancel this turn alone. */
    abort(reason?: unknown): void;
    /** Normal completion. Releases the turn WITHOUT aborting its signal. */
    end(): void;
};

type Entry = {
    controller: AbortController;
    tracked: Set<Promise<unknown>>;
};

export class OutboundLifecycleRegistry {
    private readonly entries = new Set<Entry>();

    begin(options: OutboundTurnOptions): OutboundTurn {
        const controller = new AbortController();
        const entry: Entry = { controller, tracked: new Set() };
        this.entries.add(entry);

        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            if (timer) clearTimeout(timer);
            detachCaller?.();
            this.entries.delete(entry);
        };

        // Upstream cancel reaches the vendor call. Composed rather than replaced:
        // the turn still needs its own handle for shutdown.
        let detachCaller: (() => void) | undefined;
        const caller = options.signal;
        if (caller) {
            if (caller.aborted) controller.abort(caller.reason);
            else {
                const onAbort = () => controller.abort(caller.reason);
                caller.addEventListener('abort', onAbort, { once: true });
                detachCaller = () => caller.removeEventListener('abort', onAbort);
            }
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        if (options.totalDeadlineMs !== undefined) {
            timer = setTimeout(() => {
                controller.abort(SHUTDOWN_ABORT_REASON);
                release();
            }, options.totalDeadlineMs);
            // Node keeps the process alive for a pending timer; a turn's deadline
            // is not a reason to hold the runtime open.
            timer.unref?.();
        }

        return {
            channel: options.channel,
            path: options.path,
            signal: controller.signal,
            track: (work) => {
                if (released) return;
                // Rejections are the caller's to report; here they only mean the
                // work is no longer in flight.
                const settled = work.catch(() => undefined);
                entry.tracked.add(settled);
                void settled.finally(() => { entry.tracked.delete(settled); });
            },
            abort: (reason) => { controller.abort(reason); release(); },
            end: release,
        };
    }

    get size(): number { return this.entries.size; }

    /**
     * Give live turns a bounded chance to finish, then cancel what is left.
     *
     * Same shape as QueueNoticeRegistry.drain and for the same reason: racing the
     * deadline only stops WAITING, so the abort afterwards is what actually stops
     * the work. The difference is what gets aborted — there, a cleanup we chose to
     * start; here, a send that was already running.
     */
    async drain(timeoutMs = 3000): Promise<void> {
        const pending = [...this.entries];
        // Cleared before awaiting so a re-entered shutdown cannot drain twice.
        this.entries.clear();
        if (!pending.length) return;

        const abortAll = () => {
            for (const entry of pending) entry.controller.abort(SHUTDOWN_ABORT_REASON);
        };
        const tracked = pending.flatMap(entry => [...entry.tracked]);
        // Nothing to wait for: abort immediately rather than sleeping out a
        // deadline on turns that registered no work.
        if (!tracked.length) { abortAll(); return; }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        });
        try {
            await Promise.race([
                Promise.allSettled(tracked).then(() => undefined),
                deadline,
            ]);
        } finally {
            if (timer) clearTimeout(timer);
            abortAll();
        }
    }
}
