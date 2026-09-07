// Bounded, fail-closed walk over the wiki vault.
//
// The digest reader next door already settled what it takes to read one file out of this
// vault safely: open without following the final link, judge the descriptor rather than
// the name, and compare device and inode so a path swapped after the check cannot vouch
// for a different file. A scanner reading the same vault to a weaker standard would give
// two answers to one question, so it inherits that contract and adds what a walk needs on
// top — limits, and an anchor that does not move.
//
// The anchor is the point. Every containment test measures against the root, so a root
// replaced by a link to somewhere else moves the ruler along with the thing being
// measured: relative paths stay inside, inodes agree, and the walk reads a stranger's
// files while reporting success. The anchor is fixed once from the root the setting
// names, re-checked before each directory read, and confirmed again at the end.

import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    lstatSync,
    openSync,
    readSync,
    readdirSync,
    realpathSync,
    statSync,
} from 'node:fs';
import { join } from 'node:path';
import { isPathInside, MAX_NOTE_BYTES, NOTE_FILE_EXT } from '../notes/path-guards.js';

/** Files read in one scan. Beyond this the scan stops and says so. */
export const MAX_ENTITY_FILES = 5000;
/** Directory depth below the vault root. Ordinary layouts nest a fraction of this. */
export const MAX_ENTITY_DEPTH = 8;
/** Per file. Same ceiling notes already use, rather than a second number to reason about. */
export const MAX_ENTITY_FILE_BYTES = MAX_NOTE_BYTES;
/** Across the whole scan, so many small files cannot walk past the per-file cap. */
export const MAX_ENTITY_TOTAL_BYTES = 32 * 1024 * 1024;

export type SkipReason =
    | 'not_a_regular_file'
    | 'symlink'
    | 'hardlink'
    | 'too_large'
    | 'escapes_vault'
    | 'swapped'
    | 'unreadable';

export type ScanSkip = { relPath: string; reason: SkipReason };

export type ScanFile = { relPath: string; text: string };

export type ScanError =
    | 'root_missing'
    | 'root_symlink'
    | 'root_not_a_directory'
    | 'root_moved';

export type ScanOutcome =
    | { ok: true; files: ScanFile[]; skipped: ScanSkip[]; truncated: boolean }
    | { ok: false; error: ScanError };

export type ScanDeps = {
    lstatSync: typeof lstatSync;
    realpathSync: typeof realpathSync;
    readdirSync: typeof readdirSync;
    openSync: typeof openSync;
    readSync: typeof readSync;
    fstatSync: typeof fstatSync;
    statSync: typeof statSync;
    closeSync: typeof closeSync;
};

const REAL_DEPS: ScanDeps = {
    lstatSync, realpathSync, readdirSync, openSync, readSync, fstatSync, statSync, closeSync,
};

/**
 * Fixes the anchor, or explains why the root cannot be trusted.
 *
 * `stored` must be the root as the setting spells it, never a resolved one. Comparing a
 * resolved root against itself always agrees, including on a vault that was swapped a
 * moment ago.
 */
function anchorRoot(stored: string, deps: ScanDeps): { ok: true; anchor: string } | { ok: false; error: ScanError } {
    let entry;
    try {
        entry = deps.lstatSync(stored);
    } catch {
        return { ok: false, error: 'root_missing' };
    }
    if (entry.isSymbolicLink()) return { ok: false, error: 'root_symlink' };
    if (!entry.isDirectory()) return { ok: false, error: 'root_not_a_directory' };

    let anchor: string;
    try {
        anchor = deps.realpathSync(stored);
    } catch {
        return { ok: false, error: 'root_missing' };
    }
    // The root the setting names must still be the directory it names. Anything else and
    // the walk would be measuring against a destination the user never chose.
    if (anchor !== stored) return { ok: false, error: 'root_moved' };
    return { ok: true, anchor };
}

function readWithinLimit(fd: number, size: number, deps: ScanDeps): string {
    const cap = Math.min(size, MAX_ENTITY_FILE_BYTES);
    const buffer = Buffer.allocUnsafe(cap);
    let filled = 0;
    // Short reads are ordinary on network and FUSE mounts, and treating one as the end of
    // the file is exactly how a truncated note would reach the parser.
    while (filled < cap) {
        const read = deps.readSync(fd, buffer, filled, cap - filled, filled);
        if (read <= 0) break;
        filled += read;
    }
    return buffer.subarray(0, filled).toString('utf8');
}

/** Reads one file under the anchor, or says why it was passed over. */
function readEntry(
    anchor: string,
    absolute: string,
    relPath: string,
    deps: ScanDeps,
): { file: ScanFile } | { skip: SkipReason } {
    let fd: number | undefined;
    try {
        // O_NOFOLLOW refuses a link at the final component; O_NONBLOCK stops a named pipe
        // from hanging the open until someone writes to it.
        fd = deps.openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        const stat = deps.fstatSync(fd);
        if (!stat.isFile()) return { skip: 'not_a_regular_file' };
        // A hardlink is genuinely inside the vault under one of its names while its
        // content belongs to a file elsewhere, which no path check can see.
        if (stat.nlink !== 1) return { skip: 'hardlink' };
        if (stat.size > MAX_ENTITY_FILE_BYTES) return { skip: 'too_large' };

        // Containment is judged on the canonical path, because O_NOFOLLOW only covers the
        // last component: an intermediate directory swapped for a link would otherwise
        // open a file outside the vault.
        const realPath = deps.realpathSync(absolute);
        if (!isPathInside(anchor, realPath)) return { skip: 'escapes_vault' };
        // And that canonical path must be the file this descriptor holds. A swap between
        // the open and the resolve would otherwise let a checked path speak for another
        // file; a descriptor cannot be re-pointed once open.
        const canonical = deps.statSync(realPath);
        if (canonical.dev !== stat.dev || canonical.ino !== stat.ino) return { skip: 'swapped' };

        return { file: { relPath, text: readWithinLimit(fd, stat.size, deps) } };
    } catch {
        // Vanishing files are routine in a walk, not a reason to abandon it.
        return { skip: 'unreadable' };
    } finally {
        if (fd !== undefined) {
            try { deps.closeSync(fd); } catch { /* already gone */ }
        }
    }
}

/**
 * Walks the vault under `stored`, returning the text of every note it could read safely.
 *
 * Hitting a limit is not a failure: the scan stops and marks itself truncated, because a
 * partial answer the caller knows is partial beats no answer at all. A root that moved is
 * a failure, and it discards whatever had been collected, since entries gathered after
 * the swap belong to someone else.
 */
export function scanVaultFiles(stored: string, deps: ScanDeps = REAL_DEPS): ScanOutcome {
    const anchored = anchorRoot(stored, deps);
    if (!anchored.ok) return anchored;
    const { anchor } = anchored;

    const files: ScanFile[] = [];
    const skipped: ScanSkip[] = [];
    let totalBytes = 0;
    let truncated = false;
    let moved: ScanError | null = null;

    const walk = (relDir: string, depth: number): void => {
        if (truncated || moved) return;
        if (depth > MAX_ENTITY_DEPTH) { truncated = true; return; }

        // Re-anchor before every directory read: a root swapped mid-walk must not be able
        // to redirect the rest of it.
        const still = anchorRoot(stored, deps);
        if (!still.ok || still.anchor !== anchor) { moved = still.ok ? 'root_moved' : still.error; return; }

        let entries;
        try {
            entries = deps.readdirSync(join(anchor, relDir), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
            if (truncated || moved) return;
            const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) { skipped.push({ relPath: childRel, reason: 'symlink' }); continue; }
            if (entry.isDirectory()) { walk(childRel, depth + 1); continue; }
            if (!entry.isFile() || !childRel.endsWith(NOTE_FILE_EXT)) continue;

            if (files.length >= MAX_ENTITY_FILES) { truncated = true; return; }
            const result = readEntry(anchor, join(anchor, childRel), childRel, deps);
            if ('skip' in result) { skipped.push({ relPath: childRel, reason: result.skip }); continue; }
            totalBytes += Buffer.byteLength(result.file.text, 'utf8');
            files.push(result.file);
            if (totalBytes >= MAX_ENTITY_TOTAL_BYTES) { truncated = true; return; }
        }
    };

    walk('', 0);
    if (moved) return { ok: false, error: moved };

    // One last look: a swap after the final directory read would otherwise go unnoticed.
    const closing = anchorRoot(stored, deps);
    if (!closing.ok || closing.anchor !== anchor) {
        return { ok: false, error: closing.ok ? 'root_moved' : closing.error };
    }
    return { ok: true, files, skipped, truncated };
}
