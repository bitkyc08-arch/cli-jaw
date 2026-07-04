import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Path guards for the design store (186 Phase 2 rules): reject absolute
 * paths, NUL, backslashes and `..`; confine every read/write under the page
 * directory via realpath; reject symlinks and symlinked parents. Writes are
 * additionally restricted to a v1 allowlist.
 */

const MAX_REL_LENGTH = 512;

export function isSafeRelPath(rel: string): boolean {
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_REL_LENGTH) return false;
    if (rel.includes('\0') || rel.includes('\\')) return false;
    if (isAbsolute(rel)) return false;
    const segments = rel.split('/');
    return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** v1 write allowlist: artifact.html | prompt.md | page.json | assets/*. */
export function isWritablePagePath(rel: string): boolean {
    if (!isSafeRelPath(rel)) return false;
    if (rel === 'artifact.html' || rel === 'prompt.md' || rel === 'page.json') return true;
    return rel.startsWith('assets/');
}

function rejectSymlinkChain(rootDir: string, absolutePath: string): void {
    // Walk from the target up to the root; any symlink in the chain is refused.
    let current = absolutePath;
    while (current.startsWith(rootDir + sep) || current === rootDir) {
        try {
            if (lstatSync(current).isSymbolicLink()) {
                throw new Error(`symlink not allowed: ${current}`);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                // Not created yet (write path): keep walking parents.
            } else if ((error as Error).message.startsWith('symlink not allowed')) {
                throw error;
            }
        }
        if (current === rootDir) break;
        current = dirname(current);
    }
}

/**
 * Resolve `rel` inside `rootDir`, guaranteeing lexical AND realpath
 * containment. Throws on escape attempts or symlinks.
 */
export function confinePagePath(rootDir: string, rel: string): string {
    if (!isSafeRelPath(rel)) throw new Error(`unsafe path: ${rel}`);
    const rootAbs = resolve(rootDir);
    const target = resolve(join(rootAbs, rel));
    if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
        throw new Error(`path escapes page directory: ${rel}`);
    }
    // Realpath the deepest existing ancestor to catch symlinked parents.
    let probe = target;
    for (;;) {
        try {
            const real = realpathSync(probe);
            const rootReal = realpathSync(rootAbs);
            if (real !== rootReal && !real.startsWith(rootReal + sep)) {
                throw new Error(`path escapes page directory (realpath): ${rel}`);
            }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && probe !== rootAbs) {
                probe = dirname(probe);
                continue;
            }
            if ((error as Error).message.startsWith('path escapes')) throw error;
            break;
        }
    }
    rejectSymlinkChain(rootAbs, target);
    return target;
}
