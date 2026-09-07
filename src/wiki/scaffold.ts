// ─── Idempotent vault scaffold ────────
// Runs only when the vault is being enabled. Directories are created recursively and
// seed files are written with the exclusive flag, so an existing Markdown file is never
// overwritten — a user who points the vault at a directory they already keep notes in
// keeps every one of them.

import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { WIKI_REQUIRED_DIRS } from './config.js';

const SEEDS: Record<string, string> = {
    'WIKI.md': '# Jaw Wiki\n\nPlain Markdown knowledge vault.\n',
    'index.md': '# Index\n\n- [[inbox]]\n- [[syntheses/compiled-digest]]\n',
    'inbox.md': '# Inbox\n',
    'syntheses/compiled-digest.md': '# Compiled Digest\n',
};

// Creating a directory that is already a symlink, or writing through one, would place
// vault files somewhere the user never chose — the same escape the Notes guards exist to
// prevent. Every path is checked before it is written to, not after.
async function assertInsideVault(root: string, path: string): Promise<void> {
    let realTarget: string;
    try {
        realTarget = await realpath(path);
    } catch (error) {
        // Not existing yet is the normal case for a scaffold.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    const realRoot = await realpath(root);
    const rel = relative(realRoot, realTarget);
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
        throw Object.assign(
            new Error(`wiki vault path escapes its root: ${path}`),
            { code: 'wiki_path_escape' },
        );
    }
}

async function assertNotSymlink(path: string): Promise<void> {
    try {
        if ((await lstat(path)).isSymbolicLink()) {
            throw Object.assign(
                new Error(`wiki vault path is a symlink: ${path}`),
                { code: 'wiki_symlink_rejected' },
            );
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

async function writeExclusive(path: string, content: string): Promise<void> {
    try {
        await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
        // Only "it already exists" is success. Anything else — a permission error, a
        // path that is a directory — has to surface, or enable would report a vault it
        // never actually built.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
}

export async function scaffoldWikiVault(root: string): Promise<void> {
    // The root is rejected if it is a symlink, and so is every path inside it. A vault
    // reached through a link cannot be checked for containment reliably, and a linked
    // path inside it silently redirects writes somewhere the user never chose.
    await assertNotSymlink(root);
    await mkdir(root, { recursive: true });
    for (const dir of WIKI_REQUIRED_DIRS) {
        const path = join(root, dir);
        await assertNotSymlink(path);
        await assertInsideVault(root, path);
        await mkdir(path, { recursive: true });
    }
    for (const [name, content] of Object.entries(SEEDS)) {
        const path = join(root, name);
        await assertNotSymlink(path);
        await assertInsideVault(root, path);
        await writeExclusive(path, content);
    }
}
