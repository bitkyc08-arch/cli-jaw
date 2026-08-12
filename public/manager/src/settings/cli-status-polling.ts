// #312: the Settings panel used to read /api/cli-status once, so a probe that
// was still running when the page mounted left "상태 확인 중" on screen forever.
//
// The server cannot fix this on its own: CliStatusCache is demand-driven and
// has no timer (src/cli/cli-status.ts), so a snapshot only advances when
// somebody reads it again. The UI has to be that somebody — but bounded, since
// a read can fork a worker that runs real CLI probes.

export type CliStatusProbeState = 'checking' | 'fresh' | 'stale' | 'failing';

export type PollableCliStatus = {
    probeState?: CliStatusProbeState;
    /** Server-provided backoff deadline, present while probeState is `failing`. */
    nextRetryAt?: number;
};

/** Floor for the first delay: a GET can fork a worker running real CLI probes. */
export const CLI_STATUS_MIN_DELAY_MS = 1_000;
export const CLI_STATUS_MAX_DELAY_MS = 8_000;

/**
 * The worker itself may legitimately run for 60s
 * (WORKER_OUTER_TIMEOUT_MS in src/cli/cli-status-worker.ts). Give it that plus
 * room for one observing read, or a healthy slow host gets reported as a
 * timeout.
 */
export const CLI_STATUS_POLL_HORIZON_MS = 90_000;
export const CLI_STATUS_MAX_ATTEMPTS = 24;

/**
 * `failing` is deliberately NOT terminal. The cache restarts probing on the
 * first read after its backoff expires, so a UI that stops on `failing` would
 * simply swap one permanent notice for another and never observe the recovery.
 */
export function shouldPollCliStatus(
    snapshot: Record<string, PollableCliStatus> | null | undefined,
    cli: string | null | undefined,
): boolean {
    if (!snapshot || !cli) return false;
    const state = snapshot[cli]?.probeState;
    if (!state) return false;
    return state === 'checking' || state === 'failing';
}

/** Gentle backoff between the floor and the ceiling. */
export function nextCliStatusPollDelay(attempt: number): number {
    const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
    const delay = CLI_STATUS_MIN_DELAY_MS * 2 ** Math.min(step, 8);
    return Math.min(Math.max(delay, CLI_STATUS_MIN_DELAY_MS), CLI_STATUS_MAX_DELAY_MS);
}

export type PollSchedule =
    | { kind: 'stop' }
    | { kind: 'exhausted' }
    | { kind: 'wait'; delayMs: number };

/**
 * Decides the next move. Two independent bounds, neither of which resets on
 * server responses: a wall-clock deadline and a cap on real requests. Waiting
 * out a server backoff must NOT consume an attempt, or a host that is merely
 * backing off would be declared timed-out without ever being asked again.
 */
export function planCliStatusPoll(input: {
    snapshot: Record<string, PollableCliStatus> | null | undefined;
    cli: string | null | undefined;
    attempts: number;
    now: number;
    deadline: number;
}): PollSchedule {
    const { snapshot, cli, attempts, now, deadline } = input;
    if (!shouldPollCliStatus(snapshot, cli)) return { kind: 'stop' };
    if (now >= deadline) return { kind: 'exhausted' };
    if (attempts >= CLI_STATUS_MAX_ATTEMPTS) return { kind: 'exhausted' };

    const backoff = snapshot?.[cli!]?.nextRetryAt;
    const earliest = typeof backoff === 'number' && backoff > now
        ? backoff
        : now + nextCliStatusPollDelay(attempts);
    // A backoff reaching past the deadline means the answer will not arrive in
    // time: wait until the deadline and report exhaustion there rather than
    // firing a doomed request or arming an unbounded timer.
    const target = Math.min(earliest, deadline);
    return { kind: 'wait', delayMs: Math.max(target - now, 0) };
}
