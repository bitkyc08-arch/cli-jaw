/**
 * lib/mcp/skills-reset.ts
 * Soft/hard reset and recovery for skills.
 */
import fs from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import {
    JAW_HOME,
    shouldSkipClone, writeCloneMeta, CLONE_TIMEOUT_MS,
    CODEX_ACTIVE, OPENCLAW_ACTIVE,
    copyDirRecursive, findPackageRoot,
    isDiscoverableSkillDirName, isSkillSourceEntryName, shouldUseLocalSkillsSource,
} from './skills-utils.js';

type SkillRegistry = {
    skills?: Record<string, { category?: string }>;
};
import {
    ensureWorkingDirSkillsLinks,
    createBackupContext,
    movePathToBackup,
} from './skills-symlinks.js';
import { copyDefaultSkills, reportNamespaceMigration } from './skills-distribution.js';
import { normalizeSkillNamespace } from './skills-migration.js';
import { stripUndefined } from '../../src/core/strip-undefined.js';

// ─── Types ─────────────────────────────────────────

export type SkillResetMode = 'soft' | 'hard';

type SkillResetCoreResult = {
    restored: number;
    added: number;
    copied?: number;
};

export type SkillResetResult = SkillResetCoreResult & {
    mode: SkillResetMode;
    symlinks?: ReturnType<typeof ensureWorkingDirSkillsLinks>;
    repairedPaths?: string[];
};

// ─── Soft reset ────────────────────────────────────

/**
 * Soft reset: registry에 등록된 스킬만 번들 초기값으로 복원.
 * 미등록(커스텀) 스킬은 보존.
 */
export function softResetSkills() {
    const activeDir = join(JAW_HOME, 'skills');
    const refDir = join(JAW_HOME, 'skills_ref');
    const packageRefDir = join(findPackageRoot(), 'skills_ref');

    // 1. Source for ref update: GitHub clone (latest) → bundled fallback (dev)
    const SKILLS_REPO = 'https://github.com/lidge-jun/cli-jaw-skills.git';
    let sourceDir: string | null = null;
    let tmpCloneDir: string | null = null;

    // 1a. Try GitHub clone first (public repo, always latest), unless local
    // bundled skills are explicitly requested for compatibility closeout work.
    if (shouldUseLocalSkillsSource()) {
        const sourceMode = process.env["JAW_SKILLS_SOURCE"] || 'local';
        console.log(`[skills:soft-reset] using local bundled source (JAW_SKILLS_SOURCE=${sourceMode})`);
    } else if (shouldSkipClone()) {
        console.log(`[skills:soft-reset] GitHub clone suppressed (cooldown active)`);
    } else {
        try {
            tmpCloneDir = join(JAW_HOME, '.skills_clone_tmp');
            if (fs.existsSync(tmpCloneDir)) fs.rmSync(tmpCloneDir, { recursive: true });
            console.log(`[skills:soft-reset] fetching latest skills from GitHub...`);
            execSync(`git clone --depth 1 ${SKILLS_REPO} "${tmpCloneDir}"`, {
                stdio: 'pipe', timeout: CLONE_TIMEOUT_MS,
            });
            writeCloneMeta(true);
            sourceDir = tmpCloneDir;
        } catch (e) {
            writeCloneMeta(false);
            console.log(`[skills:soft-reset] GitHub clone skipped: ${(e as Error).message?.slice(0, 60)}`);
            tmpCloneDir = null;
        }
    }

    // 1b. Fallback: bundled skills_ref/ (dev mode with initialized submodule)
    if (!sourceDir) {
        const bundledReady = fs.existsSync(packageRefDir) && fs.existsSync(join(packageRefDir, 'registry.json'));
        if (bundledReady) {
            sourceDir = packageRefDir;
            console.log(`[skills:soft-reset] using bundled fallback`);
        } else if (fs.existsSync(join(refDir, 'registry.json'))) {
            // 1c. User already cloned into skills_ref/ manually — skip copy-to-ref, go straight to activation
            sourceDir = null;
            console.log(`[skills:soft-reset] using existing skills_ref/ (manually cloned)`);
        } else {
            console.warn(`[skills:soft-reset] ⚠️ no source available — keeping current skills unchanged`);
            return { restored: 0, added: 0 };
        }
    }

    // 2. skills_ref/ 전체를 소스에서 다시 복사 (덮어쓰기)
    // sourceDir === null means existing skills_ref/ is already populated (manual clone) — skip copy
    if (sourceDir) {
        for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
            if (!isSkillSourceEntryName(entry.name)) continue;
            const src = join(sourceDir, entry.name);
            const dst = join(refDir, entry.name);
            if (entry.isDirectory()) {
                if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
                copyDirRecursive(src, dst);
            } else if (entry.isFile()) {
                fs.copyFileSync(src, dst);
            }
        }
    }

    // Cleanup temp clone
    if (tmpCloneDir && fs.existsSync(tmpCloneDir)) {
        fs.rmSync(tmpCloneDir, { recursive: true, force: true });
    }

    // 3. Build autoActivate set before touching active dir
    const autoActivate = new Set([...CODEX_ACTIVE, ...OPENCLAW_ACTIVE]);
    try {
        const regPath = join(refDir, 'registry.json');
        if (fs.existsSync(regPath)) {
            const reg = JSON.parse(fs.readFileSync(regPath, 'utf8')) as SkillRegistry;
            for (const [id, meta] of Object.entries(reg.skills || {})) {
                if (meta.category === 'orchestration') autoActivate.add(id);
            }
        }
    } catch { /* registry parse error — skip */ }

    // 4. active skills: update from ref, remove non-active (keep pure custom)
    let restored = 0;
    let removed = 0;
    if (fs.existsSync(activeDir)) {
        for (const d of fs.readdirSync(activeDir, { withFileTypes: true })) {
            if (!d.isDirectory() || !isDiscoverableSkillDirName(d.name)) continue;
            const src = join(refDir, d.name);
            const dst = join(activeDir, d.name);
            if (!fs.existsSync(src)) continue;  // ref에 없으면 보존 (순수 커스텀)
            if (!autoActivate.has(d.name)) {
                fs.rmSync(dst, { recursive: true, force: true });
                removed++;
                continue;
            }
            fs.rmSync(dst, { recursive: true, force: true });
            copyDirRecursive(src, dst);
            restored++;
        }
    }

    // 5. AUTO_ACTIVATE 중 아직 active에 없는 것 추가
    let added = 0;
    for (const id of autoActivate) {
        const src = join(refDir, id);
        const dst = join(activeDir, id);
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        copyDirRecursive(src, dst);
        added++;
    }

    // 6. Cleanup temp clone
    if (tmpCloneDir && fs.existsSync(tmpCloneDir)) {
        fs.rmSync(tmpCloneDir, { recursive: true, force: true });
    }

    // Legacy-named directories survive step 4 (their ref counterpart is gone,
    // so they read as custom). Back them up and re-establish compat links.
    reportNamespaceMigration(normalizeSkillNamespace(activeDir, JAW_HOME));

    console.log(`[skills:soft-reset] restored=${restored}, added=${added}, removed=${removed}`);
    return { restored, added };
}

// ─── Hard reset ────────────────────────────────────

function runHardSkillResetCore(): SkillResetCoreResult {
    const activeDir = join(JAW_HOME, 'skills');
    const refDir = join(JAW_HOME, 'skills_ref');
    if (fs.existsSync(activeDir)) fs.rmSync(activeDir, { recursive: true, force: true });
    if (fs.existsSync(refDir)) fs.rmSync(refDir, { recursive: true, force: true });
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(refDir, { recursive: true });
    const copied = copyDefaultSkills();
    return { restored: 0, added: copied, copied };
}

// ─── Repair helpers ────────────────────────────────

function isTrustedRepairTarget(repairTargetDir: string, jawHome = JAW_HOME): boolean {
    return resolve(repairTargetDir) === resolve(jawHome);
}

function looksLikeCliJawLegacySkillsDir(targetPath: string): boolean {
    if (!fs.existsSync(targetPath)) return false;
    try {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        return entries.some(entry =>
            entry.isDirectory() && fs.existsSync(join(targetPath, entry.name, 'SKILL.md')));
    } catch {
        return false;
    }
}

function repairLegacyManagedSkillDirs(
    repairTargetDir: string,
    opts: { includeClaude?: boolean; _jawHome?: string } = {},
): string[] {
    const targets = [
        join(repairTargetDir, '.agents', 'skills'),
        ...(opts.includeClaude ? [join(repairTargetDir, '.claude', 'skills')] : []),
    ];
    const repairedPaths: string[] = [];
    const backupContext = createBackupContext(opts._jawHome);

    for (const targetPath of targets) {
        if (!looksLikeCliJawLegacySkillsDir(targetPath)) continue;
        movePathToBackup(targetPath, backupContext);
        repairedPaths.push(targetPath);
    }

    return repairedPaths;
}

export function repairManagedSkillLinksAfterReset(
    repairTargetDir: string,
    opts: {
        includeClaude?: boolean;
        _homedir?: string;
        _jawHome?: string;
    } = {},
): { symlinks?: ReturnType<typeof ensureWorkingDirSkillsLinks>; repairedPaths: string[] } {
    const jawHome = opts._jawHome ?? JAW_HOME;
    if (!isTrustedRepairTarget(repairTargetDir, jawHome)) {
        return { repairedPaths: [] };
    }

    const repairedPaths = repairLegacyManagedSkillDirs(repairTargetDir, {
        includeClaude: opts.includeClaude ?? true,
        _jawHome: jawHome,
    });

    const symlinks = ensureWorkingDirSkillsLinks(repairTargetDir, stripUndefined({
        onConflict: 'skip',
        includeClaude: opts.includeClaude ?? true,
        allowReplaceManaged: true,
        _homedir: opts._homedir,
        _jawHome: jawHome,
    }));

    return { symlinks, repairedPaths };
}

// ─── Main entry ────────────────────────────────────

export function runSkillReset(options: {
    mode: SkillResetMode;
    repairTargetDir?: string | null;
    includeClaude?: boolean;
    _homedir?: string;
    _jawHome?: string;
}): SkillResetResult {
    const mode = options.mode;
    const resetResult: SkillResetCoreResult = mode === 'hard'
        ? runHardSkillResetCore()
        : softResetSkills();

    if (!options.repairTargetDir) {
        return { mode, ...resetResult };
    }

    const repair = repairManagedSkillLinksAfterReset(options.repairTargetDir, stripUndefined({
        includeClaude: options.includeClaude ?? true,
        _homedir: options._homedir,
        _jawHome: options._jawHome,
    }));

    return { mode, ...resetResult, ...repair };
}
