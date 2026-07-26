// wplive — deciding whether an instance is ours to stop.
//
// This lives apart from the runner because it is the part that can do damage.
// Stopping a process the user started is worse than leaving one of ours
// running, so every decision here is fail-closed: anything the evidence does
// not positively prove is refused.
//
// It is also the part that could not be tested. The runner is a top-level-await
// program that connects to a browser and a live manager on import, so the
// checks around it were reduced to regexes over its source — which is how a
// swallowed error and a missing pid survived a green suite. These functions are
// pure: they take what was observed and return a verdict.

/**
 * Can a journal entry justify stopping the instance on that port?
 *
 * @param journal   what a previous run wrote, or null
 * @param observed  { managerPid, instance } as measured right now; `instance`
 *                  is the manager's row for that port, or null if absent
 * @param origin    the origin this run is aligned to
 * @returns { action: 'none'|'stop'|'refuse', reason }
 */
export function recoveryDecision(journal, observed, origin) {
    if (journal === null || journal === undefined) {
        return { action: 'none', reason: 'no journal' };
    }
    if (journal === 'unreadable') {
        // A journal we cannot parse is not the same as no journal. Something
        // claimed ownership and we cannot tell what; refuse rather than assume.
        return { action: 'refuse', reason: 'journal exists but could not be read' };
    }
    if (!journal.port || typeof journal.port !== 'number') {
        return { action: 'refuse', reason: 'journal has no usable port' };
    }
    if (journal.origin !== origin) {
        return { action: 'refuse', reason: `journal is for ${journal.origin}, not ${origin}` };
    }
    if (journal.phase !== 'online') {
        // `intent` means the start may never have happened. Whatever occupies
        // that port now could be anyone's.
        return { action: 'refuse', reason: `journal phase is '${journal.phase}', not 'online'` };
    }
    if (!Number.isInteger(journal.managerPid) || !Number.isInteger(journal.instancePid)) {
        // Without both pids there is nothing to match against.
        return { action: 'refuse', reason: 'journal is missing a manager or instance pid' };
    }
    if (!observed || observed.queryFailed) {
        // Not knowing is not the same as knowing it is gone.
        return { action: 'refuse', reason: 'could not read the instance list' };
    }
    if (journal.managerPid !== observed.managerPid) {
        return { action: 'refuse', reason: `journal was written against manager ${journal.managerPid}, now ${observed.managerPid}` };
    }
    if (!observed.instance) {
        return { action: 'refuse', reason: `instance ${journal.port} is not in the list; cannot confirm it is gone` };
    }
    if (observed.instance.status !== 'online') {
        return { action: 'none', reason: `instance ${journal.port} is '${observed.instance.status}'` };
    }
    const livePid = observed.instance.lifecycle?.pid;
    if (!Number.isInteger(livePid)) {
        return { action: 'refuse', reason: `instance ${journal.port} reports no pid; ownership unprovable` };
    }
    if (livePid !== journal.instancePid) {
        return { action: 'refuse', reason: `:${journal.port} is pid ${livePid}, not the ${journal.instancePid} we started` };
    }
    return { action: 'stop', reason: `pid ${livePid} matches the journal` };
}

/**
 * Is it safe for THIS run to stop the instance it started?
 *
 * The same question as above, asked at teardown. A run that recorded intent but
 * never confirmed a pid must not stop anything: between the failed start and
 * the cleanup, someone else may have taken the port.
 */
export function cleanupDecision(owned, observed) {
    if (!owned?.port) return { action: 'none', reason: 'nothing was started' };
    if (!Number.isInteger(owned.instancePid)) {
        return {
            action: 'refuse',
            reason: `started :${owned.port} but never confirmed its pid; not stopping anything`,
        };
    }
    if (!observed || observed.queryFailed) {
        return { action: 'refuse', reason: 'could not read the instance list' };
    }
    if (Number.isInteger(owned.managerPid) && owned.managerPid !== observed.managerPid) {
        return { action: 'refuse', reason: 'the manager restarted since we started the instance' };
    }
    if (!observed.instance) {
        return { action: 'refuse', reason: `instance ${owned.port} vanished from the list` };
    }
    if (observed.instance.status !== 'online') {
        return { action: 'none', reason: `already '${observed.instance.status}'` };
    }
    const livePid = observed.instance.lifecycle?.pid;
    if (!Number.isInteger(livePid) || livePid !== owned.instancePid) {
        return { action: 'refuse', reason: `:${owned.port} is now pid ${livePid ?? 'unknown'}, not ours (${owned.instancePid})` };
    }
    return { action: 'stop', reason: `pid ${livePid} is ours` };
}

/**
 * Has a stop actually taken effect?
 *
 * Only `offline` counts. `timeout`, `error` and `unknown` all describe a
 * manager that cannot reach the instance, which is exactly what a live but
 * wedged process looks like.
 */
export function stopConfirmed(observed) {
    if (!observed || observed.queryFailed) return { done: false, reason: 'instance list unavailable' };
    if (!observed.instance) return { done: false, reason: 'instance missing from the list' };
    return observed.instance.status === 'offline'
        ? { done: true, reason: null }
        : { done: false, reason: `status is '${observed.instance.status}', not 'offline'` };
}

/**
 * Is a lock file still held by a live run?
 *
 * A lock left behind by a crashed run should not block the next one forever,
 * but a lock held by a running one must. The holder's pid is checked rather
 * than asking a human to guess.
 */
export function lockVerdict(contents, isAlive) {
    if (typeof contents !== 'string' || !contents.trim()) {
        return { verdict: 'stale', reason: 'lock file is empty' };
    }
    const pid = Number(contents.trim().split('-')[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
        return { verdict: 'stale', reason: 'lock file has no readable pid' };
    }
    return isAlive(pid)
        ? { verdict: 'held', reason: `pid ${pid} is still running`, pid }
        : { verdict: 'stale', reason: `pid ${pid} is gone`, pid };
}
