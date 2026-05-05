/**
 * lib/mcp/skills-symlinks.ts
 * Symlink management: ensureSymlinkSafe, contamination detection,
 * movePathToBackup, working-dir and shared-home links.
 */
import fs from 'fs';
import os from 'os';
import { join, dirname, resolve, isAbsolute } from 'path';
import { JAW_HOME } from './skills-utils.js';

// ─── Types ─────────────────────────────────────────

interface SkillsLinkOpts {
    onConflict?: 'skip' | 'backup';
    includeClaude?: boolean;
    allowReplaceManaged?: boolean;
    _homedir?: string;   // test DI — default os.homedir()
    _jawHome?: string;   // test DI — default JAW_HOME
}

type BackupContext = {
    root: string;
};

type SkillsLinkAction =
    | 'noop'
    | 'replace_symlink'
    | 'conflict_skip'
    | 'backup_replace'
    | 'error'
    | 'create';

type SkillsLinkStatus = 'ok' | 'skip' | 'error';

type SkillsLinkResult = {
    name: string;
    linkPath: string;
    target: string;
    status: SkillsLinkStatus;
    action: SkillsLinkAction;
    previousTarget?: string;
    managed?: boolean;
    backupPath?: string;
    message?: string;
};

type EnsureSymlinkSafeOpts = SkillsLinkOpts & {
    name?: string;
    jawHome?: string;
    backupContext?: BackupContext;
};

export interface SharedPathHealthReport {
    status: 'clean' | 'resolved' | 'contaminated' | 'unknown';
    paths: {
        path: string;
        exists: boolean;
        isSymlink: boolean;
        target: string | null;
        isCliJaw: boolean;
    }[];
    backupTraces: string[];
    summary: string;
}

// ─── Internal helpers ──────────────────────────────

export function createBackupContext(jawHome?: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return { root: join(jawHome ?? JAW_HOME, 'backups', 'skills-conflicts', stamp) };
}

function resolveSymlinkTarget(linkPath: string, rawTarget: string) {
    return isAbsolute(rawTarget)
        ? resolve(rawTarget)
        : resolve(dirname(linkPath), rawTarget);
}

function isCliJawManaged(linkPath: string, jawHome?: string): boolean {
    try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
            const rawTarget = fs.readlinkSync(linkPath);
            const currentTarget = resolveSymlinkTarget(linkPath, rawTarget);
            // Symlink pointing into any .cli-jaw directory is managed
            return jawHome ? currentTarget.startsWith(resolve(jawHome)) : currentTarget.includes('.cli-jaw');
        }
    } catch { /* not a symlink or doesn't exist */ }
    return false;
}

function buildLinkReport(links: SkillsLinkResult[], extra?: Record<string, unknown>) {
    const summary = links.reduce((acc, item) => {
        const key = item.action || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);
    return { links, summary, ...extra };
}

export function ensureSymlinkSafe(target: string, linkPath: string, opts: EnsureSymlinkSafeOpts = {}): SkillsLinkResult {
    const onConflict = opts["onConflict"] === 'skip' ? 'skip' : 'backup';
    const allowReplaceManaged = opts["allowReplaceManaged"] === true;
    const jawHome = opts["jawHome"];
    const backupContext = opts["backupContext"] || createBackupContext();
    const absTarget = resolve(target);
    const baseResult = {
        name: opts["name"] || '',
        linkPath,
        target,
    };

    try {
        const stat = fs.lstatSync(linkPath);

        if (stat.isSymbolicLink()) {
            const rawTarget = fs.readlinkSync(linkPath);
            const currentTarget = resolveSymlinkTarget(linkPath, rawTarget);
            if (currentTarget === absTarget) {
                return { ...baseResult, status: 'ok', action: 'noop' };
            }

            // Stale symlink: only replace if managed by cli-jaw AND caller opts in
            const managed = isCliJawManaged(linkPath, jawHome);
            if (managed && allowReplaceManaged) {
                fs.unlinkSync(linkPath);
                fs.mkdirSync(dirname(linkPath), { recursive: true });
                fs.symlinkSync(target, linkPath);
                console.log(`[skills] symlink(updated): ${linkPath} → ${target}`);
                return {
                    ...baseResult,
                    status: 'ok',
                    action: 'replace_symlink',
                    previousTarget: rawTarget,
                    managed,
                };
            }

            // Not managed, respect onConflict
            if (onConflict === 'skip') {
                console.warn(`[skills] conflict(skip): ${linkPath} (unmanaged symlink preserved)`);
                return { ...baseResult, status: 'skip', action: 'conflict_skip' };
            }
            // backup mode: fall through to backup_replace below
        }

        if (onConflict === 'skip') {
            // Non-symlink path: check if allowReplaceManaged applies
            // (real dirs are never "managed" — only symlinks can be reliably attributed to cli-jaw)
            console.warn(`[skills] conflict(skip): ${linkPath} (existing path preserved)`);
            return { ...baseResult, status: 'skip', action: 'conflict_skip' };
        }

        const backupPath = movePathToBackup(linkPath, backupContext);
        fs.mkdirSync(dirname(linkPath), { recursive: true });
        fs.symlinkSync(target, linkPath);
        console.log(`[skills] moved to backup: ${linkPath} → ${backupPath}`);
        console.log(`[skills] symlink: ${linkPath} → ${target}`);
        return {
            ...baseResult,
            status: 'ok',
            action: 'backup_replace',
            backupPath,
        };
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            return {
                ...baseResult,
                status: 'error',
                action: 'error',
                message: (e as Error).message,
            };
        }
    }

    try {
        fs.mkdirSync(dirname(linkPath), { recursive: true });
        fs.symlinkSync(target, linkPath);
        console.log(`[skills] symlink: ${linkPath} → ${target}`);
        return { ...baseResult, status: 'ok', action: 'create' };
    } catch (e: unknown) {
        return {
            ...baseResult,
            status: 'error',
            action: 'error',
            message: (e as Error).message,
        };
    }
}

export function movePathToBackup(pathToMove: string, context: BackupContext) {
    fs.mkdirSync(context["root"], { recursive: true });
    const normalized = pathToMove
        .replace(/^[a-zA-Z]:/, '')
        .replace(/^\/+/, '')
        .replace(/[\\/]/g, '__');

    const baseName = normalized || 'root';
    let backupPath = join(context["root"], baseName);
    let n = 1;
    while (fs.existsSync(backupPath)) {
        backupPath = join(context["root"], `${baseName}__${n}`);
        n += 1;
    }

    fs.renameSync(pathToMove, backupPath);
    return backupPath;
}

// ─── Public API ────────────────────────────────────

/**
 * Working-dir only: {workingDir}/.agents/skills, optionally .claude/skills.
 * NEVER touches home shared paths (~/.agents, ~/.agent, ~/.claude).
 */
export function ensureWorkingDirSkillsLinks(workingDir: string, opts: SkillsLinkOpts = {}) {
    const { _homedir = os.homedir(), _jawHome = JAW_HOME, onConflict = 'skip', includeClaude = false } = opts;
    const skillsSource = join(_jawHome, 'skills');
    fs.mkdirSync(skillsSource, { recursive: true });

    // CRITICAL: workingDir === homedir → skip to prevent implicit shared path creation
    const resolvedWd = resolve(workingDir);
    if (resolvedWd === resolve(_homedir)) {
        return buildLinkReport([], {
            skipped: true,
            reason: 'workingDir is homedir — use ensureSharedHomeSkillsLinks() for explicit opt-in',
            source: skillsSource,
        });
    }

    const { allowReplaceManaged = false } = opts;
    const backupContext = createBackupContext(_jawHome);
    const safeOpts = { onConflict, backupContext, allowReplaceManaged, jawHome: _jawHome };
    const links = [];

    // 1. {workingDir}/.agents/skills → skills source
    const wdLink = join(workingDir, '.agents', 'skills');
    links.push(ensureSymlinkSafe(skillsSource, wdLink, { ...safeOpts, name: 'wdAgents' }));

    // 2. Optionally {workingDir}/.claude/skills → skills source
    if (includeClaude) {
        const wdClaudeSkills = join(workingDir, '.claude', 'skills');
        links.push(ensureSymlinkSafe(skillsSource, wdClaudeSkills, { ...safeOpts, name: 'wdClaude' }));
    }

    return buildLinkReport(links, {
        skipped: false,
        source: skillsSource,
        strategy: onConflict,
        backupRoot: backupContext.root,
    });
}

/**
 * Opt-in only: create shared home symlinks (~/.agents/skills, ~/.agent/skills, ~/.claude/skills).
 * Must NEVER be called by default — only via explicit env flag or CLI command.
 */
export function ensureSharedHomeSkillsLinks(opts: {
    onConflict?: 'skip' | 'backup';
    includeAgents?: boolean;
    includeCompatAgent?: boolean;
    includeClaude?: boolean;
    _homedir?: string;
    _jawHome?: string;
} = {}) {
    const {
        _homedir = os.homedir(),
        _jawHome = JAW_HOME,
        onConflict = 'backup',
        includeAgents = true,
        includeCompatAgent = true,
        includeClaude = true,
    } = opts;
    const skillsSource = join(_jawHome, 'skills');
    fs.mkdirSync(skillsSource, { recursive: true });
    const backupContext = createBackupContext(_jawHome);
    const links = [];

    if (includeAgents) {
        const homeLink = join(_homedir, '.agents', 'skills');
        links.push(ensureSymlinkSafe(skillsSource, homeLink, { onConflict, backupContext, name: 'homeAgents' }));
    }
    if (includeCompatAgent) {
        const homeAgents = join(_homedir, '.agents', 'skills');
        const compatLink = join(_homedir, '.agent', 'skills');
        links.push(ensureSymlinkSafe(homeAgents, compatLink, { onConflict, backupContext, name: 'compatAgent' }));
    }
    if (includeClaude) {
        const homeClaudeSkills = join(_homedir, '.claude', 'skills');
        links.push(ensureSymlinkSafe(skillsSource, homeClaudeSkills, { onConflict, backupContext, name: 'homeClaude' }));
    }

    return buildLinkReport(links, {
        source: skillsSource,
        strategy: onConflict,
        backupRoot: backupContext.root,
    });
}

/**
 * Detect shared path contamination: check if cli-jaw has taken over home shared paths.
 */
export function detectSharedPathContamination(opts?: {
    _homedir?: string;
    _jawHome?: string;
}): SharedPathHealthReport {
    const homedir = opts?._homedir ?? os.homedir();
    const jawHome = opts?._jawHome ?? JAW_HOME;
    const skillsTarget = join(jawHome, 'skills');

    const sharedPaths = [
        join(homedir, '.agents', 'skills'),
        join(homedir, '.agent', 'skills'),
        join(homedir, '.claude', 'skills'),
    ];

    const paths = sharedPaths.map(p => {
        const exists = fs.existsSync(p);
        let isSymlink = false;
        let target: string | null = null;
        let isCliJaw = false;

        if (exists) {
            try {
                const stat = fs.lstatSync(p);
                isSymlink = stat.isSymbolicLink();
                if (isSymlink) {
                    const rawTarget = fs.readlinkSync(p);
                    target = resolveSymlinkTarget(p, rawTarget);
                    isCliJaw = resolve(target) === resolve(skillsTarget);
                }
            } catch { /* ignore */ }
        }
        return { path: p, exists, isSymlink, target, isCliJaw };
    });

    // Check backup traces
    const backupDir = join(jawHome, 'backups', 'skills-conflicts');
    const backupTraces: string[] = [];
    if (fs.existsSync(backupDir)) {
        try {
            backupTraces.push(...fs.readdirSync(backupDir).map(f => join(backupDir, f)));
        } catch { /* ignore */ }
    }

    const contaminated = paths.filter(p => p.isCliJaw);
    let status: 'clean' | 'resolved' | 'contaminated' | 'unknown' = 'clean';
    let summary = 'No shared path contamination detected';

    if (contaminated.length > 0) {
        status = 'contaminated';
        const pathList = contaminated.map(p => p.path).join(', ');
        summary = `cli-jaw symlinks found at shared paths: ${pathList}`;
    } else if (backupTraces.length > 0) {
        // Backup traces without active symlinks = previously resolved, not active contamination
        status = 'resolved';
        summary = `No active symlinks; backup traces preserved for rollback (${backupTraces.length} file(s))`;
    }

    return { status, paths, backupTraces, summary };
}

/**
 * @deprecated Use ensureWorkingDirSkillsLinks or ensureSharedHomeSkillsLinks instead.
 * Kept only for backward compatibility during transition — delegates to new helpers.
 */
export function ensureSkillsSymlinks(workingDir: string, opts: SkillsLinkOpts = {}) {
    // Delegate to working-dir-only helper (isolated-by-default)
    return ensureWorkingDirSkillsLinks(workingDir, {
        onConflict: opts["onConflict"] === 'skip' ? 'skip' : 'backup',
        includeClaude: true,
    });
}
