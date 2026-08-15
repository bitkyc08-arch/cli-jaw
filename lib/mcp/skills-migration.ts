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
import { join } from 'path';
import { LEGACY_SKILL_ALIASES } from './skills-aliases.js';
import { createBackupContext, movePathToBackup } from './skills-symlinks.js';

export interface LegacyMigrationResult {
    /** Legacy directories moved out of the way, as `<legacy> -> <backup path>`. */
    backedUp: string[];
    /** Legacy symlinks we owned and simply removed. */
    unlinked: string[];
    /** Compatibility symlinks created or repaired this pass. */
    linked: string[];
    /** Non-fatal problems (permissions, Windows symlink policy). */
    warnings: string[];
}

function emptyResult(): LegacyMigrationResult {
    return { backedUp: [], unlinked: [], linked: [], warnings: [] };
}

/** True when `p` is a symlink already pointing at `expectedTarget`. */
function pointsAt(p: string, expectedTarget: string): boolean {
    try {
        if (!fs.lstatSync(p).isSymbolicLink()) return false;
        return fs.readlinkSync(p) === expectedTarget;
    } catch {
        return false;
    }
}

/**
 * Move any real legacy skill directory out of `activeDir` into a timestamped
 * backup. Never recursive-deletes: the contents may be the user's edits.
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
            backup ??= createBackupContext(jawHome);
            const moved = movePathToBackup(legacyPath, backup);
            result.backedUp.push(`${legacyId} -> ${moved}`);
        } catch (e) {
            result.warnings.push(`could not back up ${legacyId}: ${(e as Error).message}`);
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

/** Both passes in the order they must run, for callers that just want it done. */
export function normalizeSkillNamespace(activeDir: string, jawHome: string): LegacyMigrationResult {
    const migrated = migrateLegacySkillDirs(activeDir, jawHome);
    const linked = ensureCompatSymlinks(activeDir);
    return {
        backedUp: migrated.backedUp,
        unlinked: migrated.unlinked,
        linked: linked.linked,
        warnings: [...migrated.warnings, ...linked.warnings],
    };
}

