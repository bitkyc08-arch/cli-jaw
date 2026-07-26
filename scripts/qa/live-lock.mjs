// wplive — one runner at a time, without inventing a new way to deadlock.
//
// Two runs must not overlap: they share a journal, and the second would
// overwrite the first's record of which instance it started. But a lock that a
// crashed run leaves behind must not block every future run either — this whole
// tool exists to recover from crashes.
//
// The first attempt at reconciling those used a second "reclaim guard" file to
// serialise reclamation. That moved the deadlock one step sideways: a run
// killed right after creating the guard left the guard behind, and every
// subsequent run stood down forever. A lock protocol whose failure mode is a
// permanent block is not a lock protocol.
//
// There is no need for a guard. The lock already contains the holder's pid, so
// ownership is checkable at any moment:
//
//   1. Try to create the lock exclusively. Winning is unambiguous.
//   2. If it exists, read it. A live holder means stand down — no timeout, no
//      guessing, just ask the OS whether that pid is running.
//   3. If the holder is dead, write our claim to a uniquely named file and
//      `rename` it over the lock. Rename is atomic: several runners may do this
//      concurrently and the last one wins, with no instant where the lock is
//      missing.
//   4. Read the lock back. Exactly one runner sees its own id there; everyone
//      else lost and stands down.
//
// Step 4 is what makes step 3 safe without a guard, and it cannot leave debris,
// because the only file that outlives the attempt is the lock itself.
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { unlinkSync, readFileSync } from 'node:fs';

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The pid embedded in a lock's contents, or null if there is not one. */
export function holderPid(contents) {
    const pid = Number(String(contents ?? '').trim().split('-')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Take the lock, or explain why not.
 *
 * @returns { held: true, id } | { held: false, reason, holder }
 */
export async function acquireLock(path, id, alive = isAlive) {
    try {
        await writeFile(path, id, { flag: 'wx' });
        return { held: true, id };
    } catch { /* someone has it; find out whether they are alive */ }

    let contents = '';
    try { contents = await readFile(path, 'utf8'); }
    catch { /* vanished between the two calls: fall through and try again */ }

    const pid = holderPid(contents);
    if (pid !== null && alive(pid)) {
        return { held: false, reason: `pid ${pid} is still running`, holder: pid };
    }

    // Stale. Claim it by atomic rename, then confirm we are the one who won.
    const staging = `${path}.${id}`;
    try {
        await writeFile(staging, id);
        await rename(staging, path);
    } catch (error) {
        await rm(staging, { force: true }).catch(() => {});
        return { held: false, reason: `could not claim: ${String(error.message).slice(0, 60)}`, holder: pid };
    }

    // Reading back once is not enough. Several runners can rename over the same
    // stale lock in quick succession, and each may read its own id back before
    // the next rename lands — so three of six can all conclude they won.
    //
    // Wait for the renames to stop arriving, then read once more. Whoever's id
    // is there when the file stops changing is the single holder; everyone else
    // sees somebody else's and stands down.
    let after = '';
    let previous = null;
    for (let settle = 0; settle < 5; settle += 1) {
        await new Promise((r) => setTimeout(r, 40));
        try { after = (await readFile(path, 'utf8')).trim(); } catch { after = ''; }
        if (after === previous) break;   // two identical reads: the dust settled
        previous = after;
    }
    return after === id
        ? { held: true, id, reclaimedFrom: pid }
        : { held: false, reason: 'another runner claimed it at the same moment', holder: holderPid(after) };
}

/**
 * Release the lock, but only if it is still ours.
 *
 * Deleting unconditionally is how one run removes another's lock after a
 * reclamation, which is exactly the overlap this is meant to prevent.
 */
export function releaseLockSync(path, id) {
    try {
        if (readFileSync(path, 'utf8').trim() !== id) return false;
        unlinkSync(path);
        return true;
    } catch { return false; }
}
