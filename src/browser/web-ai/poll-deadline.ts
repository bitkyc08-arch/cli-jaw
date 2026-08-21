// A hard bound on how long a provider poll may take.
//
// Ported from agbrowse `web-ai/poll-deadline.mjs` (parity round-2, catalog
// C-04/B2 — devlog/_plan/260821_agbrowse_webai_parity2/010). The provider poll
// loops check their deadline only BETWEEN awaited browser probes, so a single
// never-settling `page.evaluate`, locator call or CDP call defeats the caller's
// timeout entirely — the loop never gets to look at the clock again. Capping
// the sleeps does not help: the sleep is not where the time goes.
//
// The race is the only thing that makes the bound real, because a stalled
// probe cannot be cancelled. The losing work keeps running; what this
// guarantees is that the CALLER stops waiting for it.

/** How often the expiry timer re-checks the clock. */
const POLL_EXPIRY_CHECK_MS = 250;

/** Thrown or resolved so an expired run cannot deliver a normal envelope. */
export const POLL_EXPIRED: unique symbol = Symbol('poll-expired');
export type PollExpired = typeof POLL_EXPIRED;

/** Real elapsed time, immune to a mocked or frozen `Date.now`. */
export function monotonicNowMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
}

export interface PollDeadlineToken {
    /** Flipped once the caller has been answered. */
    expired: boolean;
    /** Reported-clock deadline in ms. */
    hardDeadline: number;
    /**
     * Shorten the bound once the run has learned its real deadline; takes an
     * ABSOLUTE time and never lengthens the bound.
     */
    tighten?: (deadlineAt: number) => void;
}

export interface PollDeadlineOptions<T> {
    /** Anchor for the reported-clock ceiling; defaults to now. Work that can
     * block — a session store read, for instance — happens before this
     * function is reached and must not be free time. */
    startedAt?: number;
    /** Anchor for the monotonic ceiling; defaults to now. */
    monotonicStartMs?: number;
    timeoutMs: number;
    onExpired: () => T;
}

/**
 * Run `runFn` under a hard deadline and return its result, or `onExpired()`.
 *
 * `runFn` receives the deadline and a token whose `expired` flag is set the
 * moment the caller is answered. A run that is still mid-tick can read that
 * flag to refuse starting new side effects — the losing work is not cancelled,
 * so without the flag it would happily finish and write.
 */
export async function withPollDeadline<T>(
    runFn: (hardDeadline: number, token: PollDeadlineToken) => Promise<T>,
    { startedAt, monotonicStartMs, timeoutMs, onExpired }: PollDeadlineOptions<T>,
): Promise<T> {
    const started = startedAt === undefined ? Date.now() : startedAt;
    const monotonicStart = monotonicStartMs === undefined ? monotonicNowMs() : monotonicStartMs;
    let hardDeadline = started + timeoutMs;
    let budgetMs = timeoutMs;
    let expire: (value: PollExpired) => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Re-armable from `tighten`, which may move the deadline inward. */
    let rearm: () => void = () => undefined;
    const expiry = new Promise<PollExpired>(resolve => {
        expire = resolve;
        // Deferring to the reported clock ALONE is unbounded: a frozen or
        // mocked `Date.now` never reaches the deadline, so the timer re-arms
        // forever and the poll returns NOTHING — strictly worse than the
        // overrun this exists to prevent.
        //
        // Two independent ceilings, because `Date.now` is not trustworthy here:
        // tests step it, and a stalled or rewound system clock would otherwise
        // leave the deadline unreachable.
        //
        //   - the reported clock reaching `hardDeadline`
        //   - MONOTONIC time exceeding the same budget
        //
        // The monotonic one is what makes the promise real: whatever the clock
        // claims, the caller waits at most one budget plus a check interval.
        // Tests that step the clock faster than real time still finish on the
        // first ceiling, so they are not cut short.
        const arm = (): void => {
            const remaining = hardDeadline - Date.now();
            const monotonicElapsedMs = monotonicNowMs() - monotonicStart;
            if (remaining <= 0 || monotonicElapsedMs >= budgetMs + POLL_EXPIRY_CHECK_MS) { resolve(POLL_EXPIRED); return; }
            timer = setTimeout(arm, Math.min(remaining, POLL_EXPIRY_CHECK_MS));
        };
        rearm = arm;
        arm();
    });
    const token: PollDeadlineToken = { expired: false, hardDeadline };
    // Only ever TIGHTENS. A run that learns its real deadline after the race is
    // armed — because reading it would have blocked the event loop, which is
    // the thing being bounded — can hand it back here. Letting it extend would
    // turn the bound into a suggestion, so a later deadline is ignored.
    //
    // ABSOLUTE, not a duration. A remainder computed after a slow read means
    // "this long from NOW"; anchoring it to `started` charged the read twice
    // and threw away that much of the caller's budget.
    token.tighten = (nextDeadlineAt: number): void => {
        if (!Number.isFinite(nextDeadlineAt) || nextDeadlineAt >= hardDeadline) return;
        hardDeadline = nextDeadlineAt;
        budgetMs = Math.max(0, nextDeadlineAt - started);
        token.hardDeadline = nextDeadlineAt;
        // Re-arm at once: the pending timer may be sleeping past the new
        // deadline, and waiting out its old delay is time the caller was not
        // promised.
        if (timer) clearTimeout(timer);
        rearm();
    };
    try {
        const run = runFn(hardDeadline, token).then(
            // Normalise BOTH settlement paths before the race: a stalled promise
            // that settles just after the deadline can have its continuation
            // scheduled ahead of the timer, and would otherwise deliver a normal
            // result — or a normal error — past the bound.
            (result): T | PollExpired => (Date.now() >= hardDeadline ? POLL_EXPIRED : result),
            (err: unknown): Promise<never> | PollExpired => (Date.now() >= hardDeadline || err === POLL_EXPIRED
                ? POLL_EXPIRED
                : Promise.reject(err)),
        );
        const outcome = await Promise.race([run, expiry]);
        if (outcome !== POLL_EXPIRED) return outcome;
        return onExpired();
    } finally {
        // Order matters: the loser may still be mid-tick, and this is what makes
        // its next side effect refuse to start instead of writing.
        token.expired = true;
        if (timer) clearTimeout(timer);
        expire(POLL_EXPIRED);
    }
}

