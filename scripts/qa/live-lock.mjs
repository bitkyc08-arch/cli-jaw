// wplive — one runner at a time, enforced by the OS rather than by timing.
//
// Two runs must not overlap: they share a journal, and the second would
// overwrite the first's record of which instance it started. But a lock a
// crashed run leaves behind must not block every future run either — this tool
// exists to recover from crashes.
//
// Two file-based attempts failed, both instructively:
//
//   A "reclaim guard" file serialised who was allowed to replace a stale lock.
//   A run killed while holding the guard left it behind and blocked every
//   subsequent run forever — the same failure it was meant to prevent, one step
//   sideways.
//
//   Then: atomic rename plus a quiet period, waiting for two identical reads
//   before declaring victory. That is not mutual exclusion, it is a guess about
//   scheduling. Two runners can both read a stale lock, both conclude the
//   holder is dead, and the second can be descheduled for longer than the
//   quiet period — then rename over a live lock and also declare victory.
//
// Both failures come from the same place: a lock built out of file contents
// needs someone to notice the holder died, and every "notice" is a race. So use
// a primitive the kernel releases on process death. Binding a loopback TCP port
// is exactly that — exclusive by definition, and gone the instant the process
// exits, however it exits. No staleness to detect, no reclamation to serialise,
// nothing left behind to orphan.
//
// The lock file remains, but only as a human-readable note about who holds it.
// It is never the thing that grants exclusion.
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';

/** Loopback port that stands for "a wplive runner is active". */
export const LOCK_PORT = 47_589;

/** The pid embedded in a lock note's contents, or null if there is not one. */
export function holderPid(contents) {
    const pid = Number(String(contents ?? '').trim().split('-')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Take the lock, or explain why not.
 *
 * @returns { held: true, id, release } | { held: false, reason, holder }
 */
export async function acquireLock(path, id, port = LOCK_PORT) {
    const server = createServer();
    const bound = await new Promise((resolve) => {
        server.once('error', () => resolve(false));
        server.once('listening', () => resolve(true));
        // Exclusive by default: no SO_REUSEADDR, no reuse of a live binding.
        server.listen({ port, host: '127.0.0.1', exclusive: true });
    });

    if (!bound) {
        // Someone holds it. The note says who, if they wrote one; it is only a
        // courtesy, and its absence changes nothing.
        let contents = '';
        try { contents = await readFile(path, 'utf8'); } catch { /* no note */ }
        const pid = holderPid(contents);
        return {
            held: false,
            reason: pid ? `pid ${pid} is still running` : `port ${port} is already bound`,
            holder: pid,
        };
    }

    // We hold it for as long as this process lives. The kernel takes it back on
    // exit — crash, SIGKILL, anything — so there is no stale state to recover.
    server.unref();
    await writeFile(path, id).catch(() => { /* the note is optional */ });

    return {
        held: true,
        id,
        release: () => {
            try { server.close(); } catch { /* already closing */ }
            try {
                if (readFileSync(path, 'utf8').trim() === id) unlinkSync(path);
            } catch { /* someone else's note, or none */ }
        },
    };
}

/**
 * Remove our note, if it is still ours.
 *
 * Exclusion is the port, not this file, so failing here is harmless. It exists
 * so a stale note does not mislead the next person reading the directory.
 */
export function releaseLockSync(path, id) {
    try {
        if (readFileSync(path, 'utf8').trim() !== id) return false;
        unlinkSync(path);
        return true;
    } catch { return false; }
}

/** Drop a note without holding the lock — used only by tests. */
export async function writeNote(path, contents) {
    await writeFile(path, contents);
}
