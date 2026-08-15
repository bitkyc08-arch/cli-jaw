/**
 * lib/mcp/skills-migration.ts
 * Filesystem migration for the jaw-* skill namespace.
 *
 * Two jobs, both idempotent and both safe to run after any activation pass:
 *
 * 1. `migrateLegacySkillDirs` — an installed home still has real directories
 *    at the old names. They are NOT deleted. A user may have edited a default
 *    skill in place, and "it is a managed skill id" is not evidence that the
 *    contents are ours. The directory is moved into
 *    `<home>/backups/skills-conflicts/<stamp>/` and the path is reported.
 *
 * 2. `ensureCompatSymlinks` — a customized `A-1.md` can contain a literal
 *    absolute path like `~/.cli-jaw/skills/search/SKILL.md`. That path is
 *    opened directly off the filesystem; it never passes through
 *    `resolveSkillId`. A `skills/<legacy> -> skills/jaw-<legacy>` symlink keeps
 *    those paths alive for one major version.
 *
 *    The link does not create a duplicate skill: every enumerator filters on
 *    `Dirent.isDirectory()`, which is false for a symlink (verified), so
 *    loadActiveSkills, the CLI listing, doctor, soft reset, and the Electron
 *    bootstrap all skip it.
 */
import fs from 'fs';
import os from 'os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { LEGACY_SKILL_ALIASES } from './skills-aliases.js';
import { createBackupContext, movePathToBackup } from './skills-symlinks.js';

export interface LegacyMigrationResult {
    /** Legacy directories moved out of the way, as `<legacy> -> <backup path>`. */
    backedUp: string[];
    /** Legacy symlinks we owned and simply removed. */
    unlinked: string[];
    /** Compatibility symlinks created or repaired this pass. */
    linked: string[];
    /** Reference directories renamed in place, as `<legacy> -> <canonical>`. */
    renamed: string[];
    /** Non-fatal problems (permissions, Windows symlink policy). */
    warnings: string[];
}

function emptyResult(): LegacyMigrationResult {
    return { backedUp: [], unlinked: [], linked: [], renamed: [], warnings: [] };
}

/**
 * True when `p` is a symlink that resolves to its sibling `expectedTarget`.
 *
 * The stored target cannot be compared literally. Windows junctions are
 * normalized to an absolute path, so a link created with the relative id reads
 * back absolute — a literal compare would call every correct link stale, and
 * each pass would unlink and recreate it forever.
 */
function pointsAt(p: string, expectedTarget: string): boolean {
    try {
        if (!fs.lstatSync(p).isSymbolicLink()) return false;
        const raw = fs.readlinkSync(p);
        const resolved = isAbsolute(raw) ? resolve(raw) : resolve(dirname(p), raw);
        return resolved === resolve(dirname(p), expectedTarget);
    } catch {
        return false;
    }
}

/**
 * True when the symlink at `p` is one of OURS: a compat link that resolves
 * somewhere inside `ownerDir`.
 *
 * A user may point `skills/jaw-browser` at a checkout of their own. Clearing
 * that to make room for a rename would destroy their setup, so only links that
 * stay inside the skill tree are ever removed.
 */
function isOwnedCompatLink(p: string, ownerDir: string): boolean {
    try {
        if (!fs.lstatSync(p).isSymbolicLink()) return false;
        const raw = fs.readlinkSync(p);
        const resolved = isAbsolute(raw) ? resolve(raw) : resolve(dirname(p), raw);
        const root = resolve(ownerDir);
        return resolved === root || resolved.startsWith(root + sep);
    } catch {
        return false;
    }
}

/**
 * True when anything at all occupies `p` — including a DANGLING symlink.
 *
 * `fs.existsSync` follows links, so a compat link pointing at a target that
 * does not exist yet reads as absent. Renaming onto that path would then
 * silently destroy the source directory instead of moving it, so occupancy
 * has to be decided with lstat.
 */
function pathIsOccupied(p: string): boolean {
    try { fs.lstatSync(p); return true; } catch { return false; }
}

/** Move `legacyPath` onto `canonicalPath`, clearing OUR stale link first. */
function renameOntoCanonical(legacyPath: string, canonicalPath: string, ownerDir: string): void {
    // Only a link we own may be cleared: a real directory is a genuine
    // collision (the caller backs the legacy copy up), and a link pointing
    // outside the tree belongs to the user.
    try {
        if (isOwnedCompatLink(canonicalPath, ownerDir)) fs.unlinkSync(canonicalPath);
    } catch { /* nothing there */ }
    fs.renameSync(legacyPath, canonicalPath);
}

/** True when the canonical path must be treated as an immovable collision. */
function canonicalIsBlocked(canonicalPath: string, ownerDir: string): boolean {
    if (!pathIsOccupied(canonicalPath)) return false;
    try {
        if (!fs.lstatSync(canonicalPath).isSymbolicLink()) return true;
    } catch { return false; }
    // A symlink is only ours to clear when it resolves inside the skill tree.
    return !isOwnedCompatLink(canonicalPath, ownerDir);
}

/**
 * Migrate any real legacy skill directory in `activeDir` onto its jaw-* name.
 *
 * When the canonical name is free the directory is RENAMED. That carries the
 * user's in-place edits forward under the new id, which is what someone who
 * edited `skills/browser/SKILL.md` actually wants — and it leaves the home with
 * a working active skill instead of an empty one.
 *
 * When both names exist the canonical copy wins and the legacy directory is
 * moved to a timestamped backup. Never recursive-deletes: the contents may be
 * the user's edits.
 */
export function migrateLegacySkillDirs(activeDir: string, jawHome: string): LegacyMigrationResult {
    const result = emptyResult();
    if (!fs.existsSync(activeDir)) return result;

    let backup: { root: string } | null = null;

    for (const [legacyId, canonicalId] of LEGACY_SKILL_ALIASES) {
        const legacyPath = join(activeDir, legacyId);

        let stat: fs.Stats | null = null;
        try { stat = fs.lstatSync(legacyPath); } catch { continue; }

        // A link we already installed is disposable — it holds no content.
        if (stat.isSymbolicLink()) {
            if (pointsAt(legacyPath, canonicalId)) continue;
            try {
                fs.unlinkSync(legacyPath);
                result.unlinked.push(legacyId);
            } catch (e) {
                result.warnings.push(`could not replace stale link ${legacyId}: ${(e as Error).message}`);
            }
            continue;
        }

        if (!stat.isDirectory()) continue;

        try {
            const canonicalPath = join(activeDir, canonicalId);
            // lstat, not existsSync: a dangling compat link occupies the path.
            if (canonicalIsBlocked(canonicalPath, activeDir)) {
                backup ??= createBackupContext(jawHome);
                const moved = movePathToBackup(legacyPath, backup);
                result.backedUp.push(`${legacyId} -> ${moved}`);
            } else {
                renameOntoCanonical(legacyPath, canonicalPath, activeDir);
                result.renamed.push(`${legacyId} -> ${canonicalId}`);
            }
        } catch (e) {
            result.warnings.push(`could not migrate ${legacyId}: ${(e as Error).message}`);
        }
    }

    return result;
}

/**
 * Create `skills/<legacy> -> jaw-<legacy>` for every canonical skill that is
 * actually installed. Idempotent: an existing correct link is left alone.
 *
 * Relative link targets keep the home relocatable, and mean a cloned or copied
 * home still resolves without rewriting anything.
 */
export function ensureCompatSymlinks(activeDir: string): LegacyMigrationResult {
    const result = emptyResult();
    if (!fs.existsSync(activeDir)) return result;

    for (const [legacyId, canonicalId] of LEGACY_SKILL_ALIASES) {
        const canonicalPath = join(activeDir, canonicalId);
        if (!fs.existsSync(canonicalPath)) continue;

        const legacyPath = join(activeDir, legacyId);
        if (pointsAt(legacyPath, canonicalId)) continue;

        // Anything real at the legacy path is handled by migrateLegacySkillDirs.
        // Never clobber it here.
        try {
            if (fs.lstatSync(legacyPath).isSymbolicLink()) fs.unlinkSync(legacyPath);
            else continue;
        } catch { /* nothing there, which is what we want */ }

        try {
            fs.symlinkSync(canonicalId, legacyPath, 'junction');
            result.linked.push(legacyId);
        } catch (e) {
            // Windows without symlink privilege, or a read-only home. The
            // canonical skill still works; only literal legacy paths suffer.
            result.warnings.push(`compat link ${legacyId} skipped: ${(e as Error).message}`);
        }
    }

    return result;
}

/**
 * Rename legacy reference directories in place: `skills_ref/<legacy>` becomes
 * `skills_ref/jaw-<legacy>`.
 *
 * The reference tree is redistributable content, not user state — it is
 * re-synced from the skills repository on every pass — so a rename is safe
 * here where it would not be under `skills/`. It is also REQUIRED: activation,
 * instance propagation, soft reset, and `skill install` all copy
 * `skills_ref/<id>` to `skills/<id>` by exact id. Leaving the reference tree on
 * legacy names means every one of those paths keeps re-creating legacy
 * directories, and the migration never converges.
 *
 * When both names already exist the canonical one wins and the legacy copy is
 * backed up rather than deleted, because a user may have edited it.
 */
export function migrateLegacyRefDirs(refDir: string, jawHome: string): LegacyMigrationResult {
    const result = emptyResult();
    if (!fs.existsSync(refDir)) return result;

    // A symlinked reference tree is BORROWED — `jaw clone --link-ref` points a
    // clone at the source home's tree. Migrating through the link would write
    // into a home this call does not own, and drop its backups under the wrong
    // home. The owner migrates it when that home is swept.
    try {
        if (fs.lstatSync(refDir).isSymbolicLink()) return result;
    } catch { return result; }

    let backup: { root: string } | null = null;

    for (const [legacyId, canonicalId] of LEGACY_SKILL_ALIASES) {
        const legacyPath = join(refDir, legacyId);
        const canonicalPath = join(refDir, canonicalId);

        let stat: fs.Stats | null = null;
        try { stat = fs.lstatSync(legacyPath); } catch { continue; }

        if (stat.isSymbolicLink()) {
            // The reference tree has no compat links; a stray one is noise.
            try {
                fs.unlinkSync(legacyPath);
                result.unlinked.push(`skills_ref/${legacyId}`);
            } catch (e) {
                result.warnings.push(`could not remove ref link ${legacyId}: ${(e as Error).message}`);
            }
            continue;
        }
        if (!stat.isDirectory()) continue;

        try {
            if (canonicalIsBlocked(canonicalPath, refDir)) {
                backup ??= createBackupContext(jawHome);
                const moved = movePathToBackup(legacyPath, backup);
                result.backedUp.push(`skills_ref/${legacyId} -> ${moved}`);
            } else {
                renameOntoCanonical(legacyPath, canonicalPath, refDir);
                result.renamed.push(`skills_ref/${legacyId} -> ${canonicalId}`);
            }
        } catch (e) {
            result.warnings.push(`could not migrate ref ${legacyId}: ${(e as Error).message}`);
        }
    }

    return result;
}

function mergeResults(...parts: LegacyMigrationResult[]): LegacyMigrationResult {
    const out = emptyResult();
    for (const p of parts) {
        out.backedUp.push(...p.backedUp);
        out.unlinked.push(...p.unlinked);
        out.linked.push(...p.linked);
        out.renamed.push(...p.renamed);
        out.warnings.push(...p.warnings);
    }
    return out;
}

/**
 * Every pass, in the order they must run, for callers that just want a home
 * fully migrated.
 *
 * The reference tree goes first: the active tree is populated FROM it, so
 * migrating `skills/` while `skills_ref/` still holds legacy names just invites
 * the next sync to put the legacy directories back.
 */
export function normalizeSkillNamespace(
    activeDir: string,
    jawHome: string,
    refDir?: string,
): LegacyMigrationResult {
    const ref = refDir ?? join(jawHome, 'skills_ref');
    return mergeResults(
        migrateLegacyRefDirs(ref, jawHome),
        migrateLegacySkillDirs(activeDir, jawHome),
        ensureCompatSymlinks(activeDir),
    );
}

/**
 * Every cli-jaw home on this machine: the base home plus every numbered or
 * named `~/.cli-jaw-*` instance.
 *
 * Instances are real installs — the manager, the dashboard, per-port runtimes —
 * and each keeps its own `skills/` and `skills_ref/`. An upgrade that migrates
 * only the home it was invoked with leaves the rest on legacy names.
 */
/**
 * A directory is only a cli-jaw home if it carries a skill tree.
 *
 * Discovery matches on a name prefix, and a name is not evidence: a user may
 * keep `~/.cli-jaw-notes` next to their install. Requiring `skills/` or
 * `skills_ref/` keeps the sweep from writing into an unrelated directory.
 * Symlinks are skipped outright — following one would let a link decide what
 * this function is allowed to touch.
 */
function looksLikeJawHome(candidate: string): boolean {
    try {
        if (fs.lstatSync(candidate).isSymbolicLink()) return false;
        if (!fs.statSync(candidate).isDirectory()) return false;
    } catch { return false; }
    return fs.existsSync(join(candidate, 'skills'))
        || fs.existsSync(join(candidate, 'skills_ref'));
}

export function discoverJawHomes(baseHome: string): string[] {
    const homes = new Set<string>();
    if (fs.existsSync(baseHome)) homes.add(baseHome);

    // Instances live beside the base home, not inside it.
    const parent = join(baseHome, '..');
    const prefix = basename(baseHome) + '-';
    try {
        for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
            if (!entry.name.startsWith(prefix)) continue;
            const candidate = join(parent, entry.name);
            // Name prefix alone proves nothing — `.cli-jaw-notes` could be the
            // user's own folder. Only a directory that actually carries a skill
            // tree is a home we may modify.
            if (!looksLikeJawHome(candidate)) continue;
            homes.add(candidate);
        }
    } catch { /* unreadable parent: the base home alone is still worth doing */ }

    return [...homes];
}

export interface HomeMigrationReport {
    home: string;
    result: LegacyMigrationResult;
}

function defaultBaseHome(): string {
    return process.env['CLI_JAW_HOME'] || join(os.homedir(), '.cli-jaw');
}

/**
 * Migrate every home on the machine. Idempotent, so it is safe to run on every
 * postinstall and from `doctor --fix`.
 */
export function migrateAllJawHomes(baseHome?: string): HomeMigrationReport[] {
    const base = baseHome ?? defaultBaseHome();
    const reports: HomeMigrationReport[] = [];
    for (const home of discoverJawHomes(base)) {
        const result = normalizeSkillNamespace(join(home, 'skills'), home, join(home, 'skills_ref'));
        const touched = result.backedUp.length + result.unlinked.length + result.linked.length
            + result.renamed.length + result.warnings.length;
        if (touched > 0) reports.push({ home, result });
    }
    return reports;
}

/**
 * True when any home still has migration work: a real legacy directory, or a
 * legacy compat link that no longer resolves to its canonical sibling.
 *
 * This must agree with what the migrators actually repair. If it only looked
 * for real directories, `doctor` would report clean while a stale link left
 * `skills/browser` pointing at nothing.
 */
export function hasPendingLegacySkillDirs(baseHome?: string): boolean {
    const base = baseHome ?? defaultBaseHome();
    for (const home of discoverJawHomes(base)) {
        for (const sub of ['skills', 'skills_ref']) {
            const subDir = join(home, sub);
            // A borrowed (symlinked) reference tree is the owner's to migrate.
            // Reporting it here would make `doctor --fix` announce work it
            // deliberately will not do, every single run.
            try { if (fs.lstatSync(subDir).isSymbolicLink()) continue; } catch { continue; }
            const isRef = sub === 'skills_ref';
            for (const [legacyId, canonicalId] of LEGACY_SKILL_ALIASES) {
                const p = join(subDir, legacyId);
                let stat: fs.Stats;
                try { stat = fs.lstatSync(p); } catch { continue; }
                if (stat.isSymbolicLink()) {
                    // The reference tree never carries compat links, and an
                    // active link is only correct while it resolves.
                    if (isRef || !pointsAt(p, canonicalId) || !fs.existsSync(p)) return true;
                    continue;
                }
                if (stat.isDirectory()) return true;
            }
        }
    }
    return false;
}
