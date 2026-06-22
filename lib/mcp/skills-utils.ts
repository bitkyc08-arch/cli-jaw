/**
 * lib/mcp/skills-utils.ts
 * Shared utilities for skills modules: clone cooldown, activation sets,
 * copyDirRecursive, findPackageRoot, version helpers.
 */
import fs from 'fs';
import os from 'os';
import { createHash } from 'crypto';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { resolveHomePath } from '../../src/core/path-expand.js';

// ─── JAW_HOME inline (config.ts → registry.ts import 체인 제거) ───
export const JAW_HOME = process.env["CLI_JAW_HOME"]
    ? resolveHomePath(process.env["CLI_JAW_HOME"])
    : join(os.homedir(), '.cli-jaw');

// ─── Clone cooldown ─────────────────────────────────
export const CLONE_META_PATH = join(JAW_HOME, '.skills_clone_meta.json');
export const CLONE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
export const CLONE_TIMEOUT_MS = 80_000;           // 80 seconds

interface CloneMeta {
    lastAttempt: number;   // epoch ms
    success: boolean;
}

export function readCloneMeta(): CloneMeta | null {
    try {
        const data = JSON.parse(fs.readFileSync(CLONE_META_PATH, 'utf8'));
        if (typeof data?.lastAttempt === 'number' && typeof data?.success === 'boolean') {
            return data;
        }
    } catch { /* corrupted or missing */ }
    return null;
}

export function writeCloneMeta(success: boolean): void {
    try {
        fs.mkdirSync(JAW_HOME, { recursive: true });
        const meta: CloneMeta = { lastAttempt: Date.now(), success };
        fs.writeFileSync(CLONE_META_PATH, JSON.stringify(meta));
    } catch (e) {
        console.warn(`[skills] clone meta write failed: ${(e as Error).message}`);
    }
}

export function shouldSkipClone(): boolean {
    if (process.env["JAW_FORCE_CLONE"] === '1') return false;
    const meta = readCloneMeta();
    if (!meta) return false;
    if (meta.success) return false;
    return (Date.now() - meta.lastAttempt) < CLONE_COOLDOWN_MS;
}

export function shouldUseLocalSkillsSource(): boolean {
    const value = (process.env["JAW_SKILLS_SOURCE"] || '').trim().toLowerCase();
    return value === 'local' || value === 'bundled' || value === 'package';
}

export function isDiscoverableSkillDirName(name: string): boolean {
    return !name.startsWith('.') && !name.endsWith('.bak') && !name.endsWith('_original');
}

export function isSkillSourceEntryName(name: string): boolean {
    return name !== '.git' && isDiscoverableSkillDirName(name);
}

// ─── Skill activation sets (shared by copyDefaultSkills / softResetSkills) ───
export const CODEX_ACTIVE = new Set([
    'pdf',
]);

export const OPENCLAW_ACTIVE = new Set([
    // vision-click is absorbed into desktop-control (reference/vision-click.md)
    // and stays as a reference skill; users who want the low-level recipe
    // can opt in with: cli-jaw skill install vision-click
    'browser', 'memory', 'search',
    'screen-capture', 'docx', 'xlsx', 'pptx', 'hwp', 'github', 'telegram-send',
    'video', 'pdf-vision', 'diagram', 'structured-renderers',
    'desktop-control',
]);

/** Walk up from current file to find package.json → package root */
export function findPackageRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== dirname(dir)) {
        if (fs.existsSync(join(dir, 'package.json'))) return dir;
        dir = dirname(dir);
    }
    return dirname(fileURLToPath(import.meta.url));
}

// ─── Version helpers ────────────────────────────────

export function semverGt(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
        if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
    }
    return false;
}

/** Shape of `registry.json` files written by skills-distribution. */
export interface SkillRegistry {
    skills?: Record<string, { version?: string; [k: string]: unknown }>;
    [k: string]: unknown;
}

export function loadRegistry(dir: string): SkillRegistry {
    try {
        return JSON.parse(fs.readFileSync(join(dir, 'registry.json'), 'utf8')) as SkillRegistry;
    } catch { return { skills: {} }; }
}

export function getSkillVersion(id: string, registry: SkillRegistry): string | null {
    return registry?.skills?.[id]?.version ?? null;
}

const SKILL_SYNC_IGNORED_DIRS = new Set(['.git', '__pycache__', 'node_modules']);
const SKILL_SYNC_IGNORED_FILES = new Set(['.DS_Store']);

function updateSkillTreeHash(hash: ReturnType<typeof createHash>, dir: string, root: string): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
        const path = join(dir, entry.name);
        try {
            if (entry.isDirectory()) {
                if (SKILL_SYNC_IGNORED_DIRS.has(entry.name)) continue;
                updateSkillTreeHash(hash, path, root);
            } else if (entry.isFile()) {
                if (SKILL_SYNC_IGNORED_FILES.has(entry.name) || entry.name.endsWith('.pyc')) continue;
                hash.update(relative(root, path).replace(/\\/g, '/'));
                hash.update('\0');
                hash.update(fs.readFileSync(path));
                hash.update('\0');
            }
        } catch {
            // Ignore disappearing files during concurrent install/sync.
        }
    }
}

function skillTreeFingerprint(dir: string): string {
    const hash = createHash('sha256');
    updateSkillTreeHash(hash, dir, dir);
    return hash.digest('hex');
}

export function shouldUpdateSkillDirectory(
    id: string,
    src: string,
    dst: string,
    srcRegistry: SkillRegistry,
    dstRegistry: SkillRegistry,
): boolean {
    const sv = getSkillVersion(id, srcRegistry);
    const dv = getSkillVersion(id, dstRegistry);
    if (sv && (!dv || semverGt(sv, dv))) return true;
    try {
        return skillTreeFingerprint(src) !== skillTreeFingerprint(dst);
    } catch {
        return false;
    }
}

/** Recursively copy a directory (symlink-safe, error-resilient) */
export function copyDirRecursive(src: string, dst: string) {
    fs.mkdirSync(dst, { recursive: true });
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const dstPath = join(dst, entry.name);
        try {
            // Resolve symlinks to their real type
            const stat = fs.statSync(srcPath);
            if (stat.isDirectory()) {
                copyDirRecursive(srcPath, dstPath);
            } else if (stat.isFile()) {
                fs.copyFileSync(srcPath, dstPath);
            }
            // Skip sockets, FIFOs, etc.
        } catch {
            // Skip broken symlinks or permission errors
        }
    }
}
