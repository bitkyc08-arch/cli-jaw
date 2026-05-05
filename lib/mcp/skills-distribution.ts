/**
 * lib/mcp/skills-distribution.ts
 * 3-way skill distribution: Codex live → GitHub clone → bundled fallback.
 * Auto-activation of CODEX_ACTIVE + OPENCLAW_ACTIVE sets.
 */
import fs from 'fs';
import os from 'os';
import { basename, join } from 'path';
import { execSync } from 'child_process';
import {
    JAW_HOME,
    shouldSkipClone, writeCloneMeta, CLONE_TIMEOUT_MS,
    CODEX_ACTIVE, OPENCLAW_ACTIVE,
    copyDirRecursive, findPackageRoot,
    semverGt, loadRegistry, getSkillVersion,
} from './skills-utils.js';

type SkillRegistry = {
    skills?: Record<string, { category?: string }>;
};

/**
 * Phase 6 — 2×3 Skill Classification at Install
 *
 * Priority: ~/.codex/skills/ (live Codex) > bundled skills_ref/ (fallback)
 *
 * 1. If Codex is installed, classify its skills into active/ref
 * 2. Copy bundled skills_ref/ (OpenClaw + Codex fallback) → ~/.cli-jaw/skills_ref/
 * 3. Auto-activate: CODEX_ACTIVE + OPENCLAW_ACTIVE from refDir → activeDir
 *    (covers devices where Codex isn't installed)
 */
export function copyDefaultSkills() {
    const activeDir = join(JAW_HOME, 'skills');
    const refDir = join(JAW_HOME, 'skills_ref');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(refDir, { recursive: true });

    let copied = 0;

    // Phase 1 dedup: these skills were merged into others — never copy from Codex
    const DEDUP_EXCLUDED = new Set([
        'spreadsheet',         // → xlsx
        'doc',                 // → docx
        'screenshot',          // → screen-capture
        'nano-pdf',            // → pdf
        'gh-issues',           // → github
        'gh-address-comments', // → github
        'gh-fix-ci',           // → github
        'yeet',                // → github
        'playwright',          // → webapp-testing
        'frontend-design',     // → dev-frontend (Orchestration v2)
    ]);

    // ─── 1. Codex live skills (if installed) ────────
    const codexSkills = join(os.homedir(), '.codex', 'skills');
    if (fs.existsSync(codexSkills)) {
        const skills = fs.readdirSync(codexSkills, { withFileTypes: true })
            .filter(d => d.isDirectory() && !DEDUP_EXCLUDED.has(d.name));

        let activeCount = 0, refCount = 0;

        for (const skill of skills) {
            const src = join(codexSkills, skill.name);

            if (CODEX_ACTIVE.has(skill.name)) {
                const dst = join(activeDir, skill.name);
                if (!fs.existsSync(dst)) {
                    copyDirRecursive(src, dst);
                    activeCount++;
                }
            } else {
                const dst = join(refDir, skill.name);
                if (!fs.existsSync(dst)) {
                    copyDirRecursive(src, dst);
                    refCount++;
                }
            }
        }
        copied += activeCount + refCount;
        console.log(`[skills] Codex: ${activeCount} active, ${refCount} ref`);
    } else {
        console.log(`[skills] Codex: not installed, using bundled fallback`);
    }

    // ─── 2. Populate skills_ref/ ─────────────────────
    // Priority: git clone (always latest) → bundled fallback (dev) → offline
    const packageRefDir = join(findPackageRoot(), 'skills_ref');
    const SKILLS_REPO = 'https://github.com/lidge-jun/cli-jaw-skills.git';

    let skillsSourceResolved = false;

    // 2a. Try GitHub clone first (public repo, no auth needed)
    if (shouldSkipClone()) {
        console.log(`[skills] GitHub clone suppressed (cooldown active)`);
    } else {
        try {
            const tmpClone = join(JAW_HOME, '.skills_clone_tmp');
            if (fs.existsSync(tmpClone)) fs.rmSync(tmpClone, { recursive: true });
            console.log(`[skills] fetching latest skills from GitHub...`);
            execSync(`git clone --depth 1 ${SKILLS_REPO} "${tmpClone}"`, {
                stdio: 'pipe', timeout: CLONE_TIMEOUT_MS,
            });
            // Version-aware merge from clone
            const srcReg = loadRegistry(tmpClone);
            const dstReg = loadRegistry(refDir);
            const cloned = fs.readdirSync(tmpClone, { withFileTypes: true });
            let cloneNew = 0, cloneUpdated = 0;
            for (const entry of cloned) {
                if (entry.name === '.git') continue;
                const src = join(tmpClone, entry.name);
                const dst = join(refDir, entry.name);
                if (entry.isDirectory()) {
                    if (!fs.existsSync(dst)) {
                        copyDirRecursive(src, dst);
                        cloneNew++;
                    } else {
                        const sv = getSkillVersion(entry.name, srcReg);
                        const dv = getSkillVersion(entry.name, dstReg);
                        if (sv && (!dv || semverGt(sv, dv))) {
                            fs.rmSync(dst, { recursive: true, force: true });
                            copyDirRecursive(src, dst);
                            cloneUpdated++;
                            console.log(`[skills] updated: ${entry.name} ${dv ?? '(none)'} → ${sv}`);
                        }
                    }
                } else if (entry.isFile()) {
                    fs.copyFileSync(src, dst);
                }
            }
            fs.rmSync(tmpClone, { recursive: true, force: true });
            console.log(`[skills] ✅ GitHub: ${cloneNew} new, ${cloneUpdated} updated`);
            writeCloneMeta(true);
            skillsSourceResolved = true;
        } catch (e) {
            writeCloneMeta(false);
            console.log(`[skills] GitHub clone skipped: ${(e as Error).message?.slice(0, 60)}`);
        }
    }

    // 2b. Fallback: bundled skills_ref/ (dev mode with initialized submodule)
    if (!skillsSourceResolved) {
        const bundledHasContent = fs.existsSync(packageRefDir) && fs.existsSync(join(packageRefDir, 'registry.json'));
        if (bundledHasContent) {
            const srcReg = loadRegistry(packageRefDir);
            const dstReg = loadRegistry(refDir);
            const entries = fs.readdirSync(packageRefDir, { withFileTypes: true });
            let refCopied = 0, refUpdated = 0;
            for (const entry of entries) {
                const src = join(packageRefDir, entry.name);
                const dst = join(refDir, entry.name);
                if (entry.isDirectory()) {
                    if (!fs.existsSync(dst)) {
                        copyDirRecursive(src, dst);
                        refCopied++;
                    } else {
                        const sv = getSkillVersion(entry.name, srcReg);
                        const dv = getSkillVersion(entry.name, dstReg);
                        if (sv && (!dv || semverGt(sv, dv))) {
                            fs.rmSync(dst, { recursive: true, force: true });
                            copyDirRecursive(src, dst);
                            refUpdated++;
                            console.log(`[skills] updated: ${entry.name} ${dv ?? '(none)'} → ${sv}`);
                        }
                    }
                } else if (entry.isFile()) {
                    fs.copyFileSync(src, dst);
                }
            }
            if (refCopied > 0) console.log(`[skills] Bundled fallback: ${refCopied} new skills → ref`);
            if (refUpdated > 0) console.log(`[skills] Bundled fallback: ${refUpdated} skills updated`);
            skillsSourceResolved = true;
        }
    }

    if (!skillsSourceResolved) {
        const hasExisting = fs.existsSync(join(refDir, 'registry.json'));
        if (!hasExisting) {
            console.warn(`[skills] ⚠️ no source available (no network + no bundled skills)`);
            console.warn(`[skills] offline mode — skills will be available after 'jaw init'`);
        }
    }

    // ─── 3. Auto-activate from refDir ───────────────
    // Promotes CODEX_ACTIVE + OPENCLAW_ACTIVE from ref → active
    // (fallback for devices without ~/.codex/skills/)
    // Orchestration v2: registry에서 category=orchestration인 스킬도 자동 활성화
    try {
        const registryPath = join(refDir, 'registry.json');
        if (fs.existsSync(registryPath)) {
            const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as SkillRegistry;
            for (const [id, meta] of Object.entries(registry.skills || {})) {
                if (meta.category === 'orchestration') OPENCLAW_ACTIVE.add(id);
            }
        }
    } catch { /* registry parse error — skip */ }
    const AUTO_ACTIVATE = new Set([...CODEX_ACTIVE, ...OPENCLAW_ACTIVE]);
    let autoCount = 0;
    for (const id of AUTO_ACTIVATE) {
        const src = join(refDir, id);
        const dst = join(activeDir, id);
        if (!fs.existsSync(src)) continue;
        if (!fs.existsSync(dst)) {
            copyDirRecursive(src, dst);
            copied++;
            autoCount++;
            console.log(`[skills] auto-activated: ${id}`);
        } else {
            // Sync active copy if ref was updated (mtime-based)
            try {
                const srcMtime = fs.statSync(join(src, 'SKILL.md')).mtimeMs;
                const dstMtime = fs.statSync(join(dst, 'SKILL.md')).mtimeMs;
                if (srcMtime > dstMtime) {
                    fs.rmSync(dst, { recursive: true, force: true });
                    copyDirRecursive(src, dst);
                    autoCount++;
                    console.log(`[skills] active synced: ${id}`);
                }
            } catch { /* SKILL.md missing in one side — skip */ }
        }
    }
    if (autoCount > 0) console.log(`[skills] Total auto-activated/synced: ${autoCount}`);

    return copied;
}

/**
 * Propagate skills from JAW_HOME to all ~/.cli-jaw-* instance directories.
 * Runs after copyDefaultSkills() so the base is already up-to-date.
 *
 * - skills_ref/: version-aware merge (new + updated)
 * - skills/ (active): update existing + auto-activate standard set
 */
export function propagateSkillsToInstances() {
    const home = os.homedir();
    const baseActive = join(JAW_HOME, 'skills');
    const baseRef = join(JAW_HOME, 'skills_ref');
    if (!fs.existsSync(baseRef)) return;

    let instances: string[];
    try {
        instances = fs.readdirSync(home, { withFileTypes: true })
            .filter(d => d.isDirectory() && /^\.cli-jaw-\d+$/.test(d.name))
            .map(d => join(home, d.name));
    } catch { return; }

    if (instances.length === 0) return;

    const srcRefReg = loadRegistry(baseRef);

    // Build auto-activate set (same logic as copyDefaultSkills)
    const autoActivate = new Set([...CODEX_ACTIVE, ...OPENCLAW_ACTIVE]);
    try {
        const registryPath = join(baseRef, 'registry.json');
        if (fs.existsSync(registryPath)) {
            const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as SkillRegistry;
            for (const [id, meta] of Object.entries(registry.skills || {})) {
                if (meta.category === 'orchestration') autoActivate.add(id);
            }
        }
    } catch { /* skip */ }

    for (const instDir of instances) {
        const instRef = join(instDir, 'skills_ref');
        const instActive = join(instDir, 'skills');
        fs.mkdirSync(instRef, { recursive: true });
        fs.mkdirSync(instActive, { recursive: true });

        // 1. Sync skills_ref/ (version-aware)
        const dstRefReg = loadRegistry(instRef);
        let refNew = 0, refUpdated = 0;
        for (const entry of fs.readdirSync(baseRef, { withFileTypes: true })) {
            const src = join(baseRef, entry.name);
            const dst = join(instRef, entry.name);
            if (entry.isDirectory()) {
                if (!fs.existsSync(dst)) {
                    copyDirRecursive(src, dst);
                    refNew++;
                } else {
                    const sv = getSkillVersion(entry.name, srcRefReg);
                    const dv = getSkillVersion(entry.name, dstRefReg);
                    if (sv && (!dv || semverGt(sv, dv))) {
                        fs.rmSync(dst, { recursive: true, force: true });
                        copyDirRecursive(src, dst);
                        refUpdated++;
                    }
                }
            } else if (entry.isFile()) {
                fs.copyFileSync(src, dst);
            }
        }

        // 2. Sync active skills: update existing + auto-activate standard set
        let activeUpdated = 0, autoActivated = 0;
        if (fs.existsSync(baseActive)) {
            for (const entry of fs.readdirSync(baseActive, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const src = join(baseActive, entry.name);
                const dst = join(instActive, entry.name);
                const srcSkill = join(src, 'SKILL.md');
                const dstSkill = join(dst, 'SKILL.md');

                if (fs.existsSync(dst)) {
                    // Update existing active skill if source is newer
                    try {
                        const srcMtime = fs.statSync(srcSkill).mtimeMs;
                        const dstMtime = fs.statSync(dstSkill).mtimeMs;
                        if (srcMtime > dstMtime) {
                            fs.rmSync(dst, { recursive: true, force: true });
                            copyDirRecursive(src, dst);
                            activeUpdated++;
                        }
                    } catch { /* SKILL.md missing — skip */ }
                } else if (autoActivate.has(entry.name)) {
                    copyDirRecursive(src, dst);
                    autoActivated++;
                }
            }
        }

        const tag = basename(instDir);
        const parts: string[] = [];
        if (refNew) parts.push(`${refNew} new ref`);
        if (refUpdated) parts.push(`${refUpdated} updated ref`);
        if (activeUpdated) parts.push(`${activeUpdated} active updated`);
        if (autoActivated) parts.push(`${autoActivated} auto-activated`);
        if (parts.length > 0) {
            console.log(`[skills] ${tag}: ${parts.join(', ')}`);
        }
    }

    console.log(`[skills] propagated to ${instances.length} instance(s)`);
}
