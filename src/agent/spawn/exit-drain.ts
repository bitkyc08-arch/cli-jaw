import type { ChildProcess } from 'child_process';

/**
 * Bound how long we wait for `close` after a child has already exited.
 *
 * A turn is resolved on `close`, which Node emits only once every stdio stream
 * is closed — not when the child exits. A descendant that inherited the child's
 * stdout/stderr keeps those pipes open after the child is gone, so `close` never
 * arrives and the turn hangs with no other recovery path: the watchdog only
 * signals the child, which has already exited.
 *
 * Short output tails still matter, so the wait is not cut immediately. The idle
 * grace restarts whenever more data arrives, and an absolute ceiling caps the
 * total wait for the pathological case.
 */
const EXIT_DRAIN_IDLE_MS = 100;
const EXIT_DRAIN_MAX_MS = 1_000;

export interface ExitDrainOptions {
    idleMs?: number;
    maxMs?: number;
    /** Called when the drain gives up and destroys the streams. */
    onRelease?: (reason: 'idle' | 'deadline') => void;
}

/**
 * Start bounding post-exit output for `child`.
 *
 * @returns a cleanup function that must run once the turn settles, so a normal
 *          run leaves no timers or listeners behind.
 */
export function releaseChildOutputAfterExit(
    child: ChildProcess,
    options: ExitDrainOptions = {},
): () => void {
    const idleMs = options.idleMs ?? EXIT_DRAIN_IDLE_MS;
    const maxMs = options.maxMs ?? EXIT_DRAIN_MAX_MS;

    let exited = false;
    let released = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let idleImmediate: NodeJS.Immediate | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
        if (idleImmediate) { clearImmediate(idleImmediate); idleImmediate = undefined; }
        if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }
    };

    const cleanup = (): void => {
        clearTimers();
        child.removeListener('exit', onExit);
        child.stdout?.removeListener('data', onData);
        child.stderr?.removeListener('data', onData);
    };

    const release = (reason: 'idle' | 'deadline'): void => {
        if (released) return;
        released = true;
        cleanup();
        child.stdout?.destroy();
        child.stderr?.destroy();
        options.onRelease?.(reason);
    };

    const armIdleTimer = (): void => {
        if (released) return;
        if (idleTimer) clearTimeout(idleTimer);
        if (idleImmediate) { clearImmediate(idleImmediate); idleImmediate = undefined; }
        idleTimer = setTimeout(() => {
            idleTimer = undefined;
            // A busy event loop can run this timer before pipe data that is
            // already buffered. Yield one poll turn so that data can re-arm the
            // grace instead of being cut off.
            idleImmediate = setImmediate(() => {
                idleImmediate = undefined;
                release('idle');
            });
            idleImmediate.unref?.();
        }, idleMs);
        idleTimer.unref?.();
    };

    function onData(): void {
        if (exited) armIdleTimer();
    }

    function onExit(): void {
        exited = true;
        armIdleTimer();
        deadlineTimer = setTimeout(() => release('deadline'), maxMs);
        deadlineTimer.unref?.();
    }

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);

    return cleanup;
}
