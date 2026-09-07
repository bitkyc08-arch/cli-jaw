#!/usr/bin/env node
// @file scripts/check-path-length.mjs
// Windows MAX_PATH regression gate (#430).
//
// A tracked path that is fine on Linux can make `git clone --recursive` fail on
// Windows, and it fails in the worst way: the clone stops midway with
// "Filename too long", earlier submodules are already checked out, so the tree
// looks healthy while one submodule is silently empty.
//
// CI runs on Linux and cannot see this condition at all, which is why it reached
// users twice (#422 then #430). A length check is the cheapest thing that can.
//
// The limit is NOT the failure threshold. MAX_PATH is 260, so the clone's
// absolute directory prefix must fit as well as the tracked relative path.
// A 150-char cap leaves room for nested checkout and public submodule roots;
// a 74-char prefix still stays below MAX_PATH with that cap.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = process.env.PATH_LENGTH_ROOT || fileURLToPath(new URL('..', import.meta.url));

/** Max tracked-path length, relative to each repo root. See the header for why 150. */
export const MAX_TRACKED_PATH_LENGTH = 150;

/** The main repo plus every submodule that ships in a `--recursive` clone. */
const SCAN_ROOTS = ['.', 'skills_ref', 'officecli'];

/**
 * Tracked paths for one root.
 *
 * `core.quotepath=false` is load-bearing: by default git C-escapes non-ASCII
 * bytes, so a Korean filename reports roughly three times its real length and a
 * naive check flags files that are perfectly fine.
 */
export function listTrackedPaths(root) {
    const result = spawnSync(
        'git', ['-C', root, '-c', 'core.quotepath=false', 'ls-files'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) return null;
    return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

export function findLongPaths(paths, limit = MAX_TRACKED_PATH_LENGTH) {
    return paths
        .filter(p => p.length > limit)
        .map(p => ({ length: p.length, path: p }))
        .sort((a, b) => b.length - a.length);
}

function main() {
    const offenders = [];
    let scanned = 0;
    let longest = { length: 0, path: '', root: '' };

    for (const rel of SCAN_ROOTS) {
        const root = join(REPO_ROOT, rel);
        // A submodule that was never initialised has nothing to check. Skipping is
        // right: this gate protects the clone, and an absent submodule cannot
        // break one.
        if (rel !== '.' && !existsSync(join(root, '.git'))) continue;
        const paths = listTrackedPaths(root);
        if (!paths) continue;
        scanned += paths.length;
        for (const p of paths) {
            if (p.length > longest.length) longest = { length: p.length, path: p, root: rel };
        }
        for (const hit of findLongPaths(paths)) offenders.push({ ...hit, root: rel });
    }

    if (offenders.length) {
        console.error(`[path-length] ${offenders.length} tracked path(s) exceed ${MAX_TRACKED_PATH_LENGTH} chars:`);
        for (const o of offenders.slice(0, 20)) {
            console.error(`  ${String(o.length).padStart(4)}  ${o.root}/${o.path}`);
        }
        console.error('\nThese break `git clone --recursive` on Windows without core.longpaths,');
        console.error('and the clone fails PARTWAY: earlier submodules look fine while this one is empty.');
        process.exit(1);
    }

    console.log(
        `[path-length] OK — ${scanned} tracked path(s), longest ${longest.length} `
        + `(${longest.root}/${longest.path}), limit ${MAX_TRACKED_PATH_LENGTH}`,
    );
}

// pathToFileURL, not string surgery: argv[1] is whatever the caller typed, so a
// relative invocation (`node scripts/check-path-length.mjs`) produced a bogus URL
// and the gate exited 0 having checked nothing — a silent pass is worse than no
// gate at all.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main();
}
