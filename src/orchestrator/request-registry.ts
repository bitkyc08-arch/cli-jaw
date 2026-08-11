/**
 * Request settlement registry (#276 / devlog 061).
 *
 * `POST /api/message` always returns a requestId, but until now that id was not
 * a promise of anything. Whether a completion event ever carried it back
 * depended on which path the server happened to take:
 *
 *   - idle -> normal run: `orchestrate_done` carried the requestId. Fine.
 *   - busy + JWC: `steerAgent` injects the prompt into the RUNNING turn and
 *     returns. No new turn exists, so no new completion event is ever emitted.
 *   - busy + non-JWC: a fresh orchestration ran but the requestId was not
 *     passed through to it or to its error broadcast.
 *   - collect queue: N requests merge into one run and only the first id
 *     survives, so N-1 callers wait forever.
 *   - queue delete / stop / shutdown / skipOrchestrate: nothing at all.
 *
 * A CLI client that submits and then waits (`jaw ask`) hangs on every one of
 * those paths. Scattering another broadcast across each completion site cannot
 * fix it: there is no way to prove the set is complete, and nothing prevents a
 * double emit.
 *
 * So settlement is a registry instead. A request is ADMITTED where its id is
 * minted, and settled through one idempotent function. That makes the
 * invariant checkable rather than asserted: after any scenario,
 * `pendingRequestIds()` must be empty. A missed call site shows up as a leak in
 * that assertion; a duplicated one is a no-op by construction.
 */
import { broadcast } from '../core/bus.js';

export type SettleOutcome =
    /** Ran to completion; `text` carries the answer. */
    | 'completed'
    /** Injected into an already-running turn. There is no separate answer. */
    | 'steered'
    /** Merged into another request's run; follow `mergedInto`. */
    | 'merged'
    /** Failed with an error. */
    | 'failed'
    /** Killed by a user or API stop. */
    | 'cancelled'
    /** Dropped from the queue, or discarded at shutdown. */
    | 'dropped'
    /** Accepted but deliberately not orchestrated. */
    | 'skipped';

export interface SettleDetail {
    text?: string;
    error?: string;
    mergedInto?: string;
    reason?: string;
    scope?: string;
    sessionId?: string;
}

interface PendingRequest {
    requestId: string;
    scope: string;
    admittedAt: number;
}

const pending = new Map<string, PendingRequest>();

/** Called where the requestId is minted, before any work is dispatched. */
export function admitRequest(requestId: string, scope = 'default', now = Date.now()): void {
    if (!requestId) return;
    pending.set(requestId, { requestId, scope, admittedAt: now });
}

/**
 * Settle a request exactly once.
 *
 * The FIRST call broadcasts `request_settled` and forgets the id; every later
 * call is a no-op. This is what makes exact-once provable rather than hoped
 * for — completion sites may overlap, and several of them legitimately do.
 */
export function settleOnce(
    requestId: string | undefined | null,
    outcome: SettleOutcome,
    detail: SettleDetail = {},
): boolean {
    if (!requestId) return false;
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    broadcast('request_settled', {
        requestId,
        outcome,
        scope: detail.scope ?? entry.scope,
        ...(detail.text !== undefined ? { text: detail.text } : {}),
        ...(detail.error !== undefined ? { error: detail.error } : {}),
        ...(detail.mergedInto !== undefined ? { mergedInto: detail.mergedInto } : {}),
        ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
        ...(detail.sessionId !== undefined ? { sessionId: detail.sessionId } : {}),
    });
    return true;
}

/**
 * Settle everything still outstanding — for stop, queue purge, and shutdown.
 * Without this a caller waiting on a purged request would never hear back.
 */
export function settleAllPending(outcome: SettleOutcome, reason: string, scope?: string): number {
    const targets = [...pending.values()].filter((entry) => !scope || entry.scope === scope);
    for (const entry of targets) settleOnce(entry.requestId, outcome, { reason });
    return targets.length;
}

/**
 * Ids admitted but not yet settled. The exact-once invariant is asserted
 * against this: after any scenario it must be empty.
 */
export function pendingRequestIds(): string[] {
    return [...pending.keys()];
}

/** @internal test helper. */
export function resetRequestRegistryForTest(): void {
    pending.clear();
}
