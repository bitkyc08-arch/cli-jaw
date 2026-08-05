// ─── Opt-in wiki vault configuration (devlog 040 §3) ──
// The vault is off by default and lives entirely in settings.json under three keys.
// There is no separate wiki.json: the existing settings path already owns the 0600
// write and chmod boundary, and a second config file would be a second thing to keep
// in sync.

import { accessSync, constants as fsConstants, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { settings } from '../core/config.js';
import { applyRuntimeSettingsPatch } from '../core/runtime-settings.js';
import type { ProviderStatus } from '../search/contract.js';

export interface WikiConfig {
    enabled: boolean;
    root: string;
    promptDigest: boolean;
}

export const DEFAULT_WIKI_CONFIG: WikiConfig = {
    enabled: false,
    root: '~/jaw-wiki',
    promptDigest: false,
};

// The directories and files a usable vault must have. Both the scaffold and the
// readiness check read this list, so a vault can never be "ready" with a layout the
// scaffold does not produce.
export const WIKI_REQUIRED_DIRS = [
    'entities',
    'entities/people',
    'entities/projects',
    'entities/systems',
    'concepts',
    'syntheses',
    'sources',
    'reports',
    '_attachments',
] as const;

export const WIKI_REQUIRED_FILES = [
    'WIKI.md',
    'index.md',
    'inbox.md',
    'syntheses/compiled-digest.md',
] as const;

// Canonical form when the path exists, otherwise the resolved text. A path that has not
// been created yet still needs to normalise, and it cannot be aliased by a link that does
// not exist either.
function canonicalOrResolved(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

export function normalizeWikiConfig(input: Partial<WikiConfig>): WikiConfig {
    const rawRoot = String(input.root ?? DEFAULT_WIKI_CONFIG.root).trim();
    if (!rawRoot) throw new Error('invalid settings.wiki.root: empty');
    const expanded = rawRoot.replace(/^~(?=$|\/)/, homedir());
    // Reject before resolving. resolve() turns '.', '..' and any relative path into an
    // absolute one, so checking isAbsolute() afterwards always passes and an empty or
    // relative root would be scaffolded relative to the process working directory.
    if (!isAbsolute(expanded)) {
        throw new Error(`invalid settings.wiki.root: must be absolute (${rawRoot})`);
    }
    const root = resolve(expanded);
    // A filesystem root would make every containment check meaningless and scatter a
    // scaffold across the whole disk.
    if (root === parse(root).root) {
        throw new Error(`invalid settings.wiki.root: refusing the filesystem root`);
    }
    // Pin the root to what it resolves to on disk right now. A configured path that runs
    // through a symlink would otherwise follow that link wherever it is later retargeted,
    // so the same setting could read a different vault than the one it was enabled for.
    // A root that does not exist yet stays as written; the scaffold creates it.
    let canonicalRoot = root;
    try {
        canonicalRoot = realpathSync(root);
    } catch { /* not created yet — normalization must still work before enable */ }
    return {
        root: canonicalRoot,
        enabled: input.enabled === true,
        promptDigest: input.promptDigest === true,
    };
}

// Roots the vault must never occupy. Pointing it at the notes vault would scatter wiki
// scaffold files through the user's notes and break the isolation the two are supposed
// to have. The roots are passed in rather than imported so core keeps no dependency on
// manager configuration (040 §0c R2).
export function assertUsableWikiRoot(root: string, forbiddenRoots: readonly string[]): void {
    // Both sides are canonicalised, because an alias reaching the forbidden root through
    // a symlink is the same directory by every meaning except the spelling.
    const target = canonicalOrResolved(root);
    for (const raw of forbiddenRoots) {
        if (!raw) continue;
        const forbidden = canonicalOrResolved(raw);
        const rel = relative(forbidden, target);
        const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        const contains = relative(target, forbidden) === ''
            || (!relative(target, forbidden).startsWith('..') && !isAbsolute(relative(target, forbidden)));
        // Either direction is a collision: the vault inside the notes root mixes files
        // into it, and the notes root inside the vault puts notes under wiki management.
        if (inside || contains) {
            throw Object.assign(
                new Error(`settings.wiki.root collides with an existing vault: ${raw}`),
                { code: 'wiki_root_collision' },
            );
        }
    }
}

// Reads the live settings binding rather than loadSettings(): that function is a boot and
// recovery operation — it rereads disk, migrates, can rewrite the file and replace the
// global object — and calling it on every config read would run all of that repeatedly.
export function readWikiConfig(): WikiConfig {
    const raw = settings["wiki"] as Partial<WikiConfig> | undefined;
    return normalizeWikiConfig({ ...DEFAULT_WIKI_CONFIG, ...raw });
}

// The enable route validates the root before it scaffolds, but the generic settings API
// and the settings-file watcher can both write this block without going near that route.
// Enforcing the rule where the config is CONSUMED is what makes it hold whatever path
// the setting arrived by.
export function readUsableWikiConfig(forbiddenRoots: readonly string[] = []): WikiConfig {
    const config = readWikiConfig();
    if (!config.enabled) return config;
    try {
        assertUsableWikiRoot(config.root, forbiddenRoots);
    } catch {
        // A root that should never have been accepted is treated as disabled rather than
        // as an error, because the vault it names is not one this instance may read.
        return { ...config, enabled: false, promptDigest: false };
    }
    return config;
}

// Writes go through the same serialized runtime-settings path every other settings
// mutation uses, so a wiki change cannot race a concurrent settings write.
export async function writeWikiConfig(next: WikiConfig): Promise<WikiConfig> {
    const normalized = normalizeWikiConfig(next);
    await applyRuntimeSettingsPatch({ wiki: normalized });
    return normalized;
}

// A disabled vault reports 'off' even when its files are all present on disk: the
// setting is the source of truth, not the directory. That is what makes disabling a
// non-destructive operation — the files stay, the provider stops answering.
export function wikiProviderStatus(config: WikiConfig): ProviderStatus {
    if (!config.enabled) return 'off';
    try {
        for (const dir of ['', ...WIKI_REQUIRED_DIRS]) {
            const path = dir ? join(config.root, dir) : config.root;
            if (!lstatSync(path).isDirectory()) return 'error';
            accessSync(path, fsConstants.R_OK);
        }
        for (const file of WIKI_REQUIRED_FILES) {
            const path = join(config.root, file);
            if (!lstatSync(path).isFile()) return 'error';
            accessSync(path, fsConstants.R_OK);
        }
        return 'ready';
    } catch {
        // A vault that was renamed, deleted, or made unreadable is an error rather than
        // an absence: the user asked for it to be on.
        return 'error';
    }
}

// The roots the vault must not occupy, registered once at composition. The registry
// exists so the consumers below can enforce the rule without importing manager config:
// core sets it at boot, everything else just asks.
let forbiddenRoots: readonly string[] = [];

export function setForbiddenWikiRoots(roots: readonly string[]): void {
    forbiddenRoots = [...roots];
}

export function forbiddenWikiRoots(): readonly string[] {
    return forbiddenRoots;
}
