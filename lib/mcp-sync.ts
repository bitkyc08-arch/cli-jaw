/**
 * lib/mcp-sync.js — Phase 12.1
 * Unified MCP config → CLI-specific format conversion.
 * Source of truth: ~/.cli-jaw/mcp.json
 *
 * Supported targets (all global):
 *   Claude Code   → ~/.mcp.json                          (JSON, mcpServers)
 *   Codex         → ~/.codex/config.toml                  (TOML, [mcp_servers.name])
 *   Gemini CLI    → ~/.gemini/settings.json               (JSON, mcpServers)
 *   OpenCode      → ~/.config/opencode/opencode.json      (JSON, mcp block)
 *   Copilot       → ~/.copilot/mcp-config.json            (JSON, mcpServers)
 *   Antigravity   → ~/.gemini/antigravity/mcp_config.json (JSON, mcpServers)
 */
import fs from 'fs';
import os from 'os';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// ─── JAW_HOME inline (config.ts → registry.ts import 체인 제거) ───
const JAW_HOME = process.env.CLI_JAW_HOME
    ? resolve(process.env.CLI_JAW_HOME.replace(/^~(?=\/|$)/, os.homedir()))
    : join(os.homedir(), '.cli-jaw');

const MCP_PATH = join(JAW_HOME, 'mcp.json');

// ─── Clone cooldown ─────────────────────────────────
const CLONE_META_PATH = join(JAW_HOME, '.skills_clone_meta.json');
const CLONE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const CLONE_TIMEOUT_MS = 15_000;           // 15 seconds (down from 120s)

interface CloneMeta {
    lastAttempt: number;   // epoch ms
    success: boolean;
}

function readCloneMeta(): CloneMeta | null {
    try {
        const data = JSON.parse(fs.readFileSync(CLONE_META_PATH, 'utf8'));
        if (typeof data?.lastAttempt === 'number' && typeof data?.success === 'boolean') {
            return data;
        }
    } catch { /* corrupted or missing */ }
    return null;
}

function writeCloneMeta(success: boolean): void {
    try {
        fs.mkdirSync(JAW_HOME, { recursive: true });
        const meta: CloneMeta = { lastAttempt: Date.now(), success };
        fs.writeFileSync(CLONE_META_PATH, JSON.stringify(meta));
    } catch (e) {
        console.warn(`[skills] clone meta write failed: ${(e as Error).message}`);
    }
}

function shouldSkipClone(): boolean {
    if (process.env.JAW_FORCE_CLONE === '1') return false;
    const meta = readCloneMeta();
    if (!meta) return false;
    if (meta.success) return false;
    return (Date.now() - meta.lastAttempt) < CLONE_COOLDOWN_MS;
}

/** Walk up from current file to find package.json → package root */
function findPackageRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== dirname(dir)) {
        if (fs.existsSync(join(dir, 'package.json'))) return dir;
        dir = dirname(dir);
    }
    return dirname(fileURLToPath(import.meta.url));
}

// ─── Load / Save unified config ────────────────────

export function loadUnifiedMcp() {
    try {
        return JSON.parse(fs.readFileSync(MCP_PATH, 'utf8'));
    } catch {
        return { servers: {} };
    }
}

export function saveUnifiedMcp(config: Record<string, any>) {
    fs.mkdirSync(JAW_HOME, { recursive: true });
    fs.writeFileSync(MCP_PATH, JSON.stringify(config, null, 4) + '\n');
}

// ─── Import from existing configs ──────────────────

/** Import from Claude-style .mcp.json into unified format */
export function importFromClaudeMcp(filePath: string) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const servers: Record<string, any> = {};
        for (const [name, srv] of Object.entries(raw.mcpServers || {}) as [string, any][]) {
            servers[name] = {
                command: srv.command,
                args: srv.args || [],
                ...(srv.env && Object.keys(srv.env).length ? { env: srv.env } : {}),
            };
        }
        return { servers };
    } catch { return { servers: {} }; }
}

// ─── Convert to CLI-specific formats ───────────────

/** → Claude Code / Gemini CLI format (.mcp.json / settings.json mcpServers block) */
export function toClaudeMcp(config: Record<string, any>) {
    const mcpServers: Record<string, any> = {};
    for (const [name, srv] of Object.entries(config.servers || {}) as [string, any][]) {
        (mcpServers as Record<string, any>)[name] = { command: srv.command, args: srv.args || [] };
        if (srv.env && Object.keys(srv.env).length) (mcpServers as Record<string, any>)[name].env = srv.env;
    }
    return { mcpServers };
}

/** → Codex config.toml MCP section string */
export function toCodexToml(config: Record<string, any>) {
    let toml = '';
    for (const [name, srv] of Object.entries(config.servers || {}) as [string, any][]) {
        toml += `[mcp_servers.${name}]\n`;
        toml += `command = "${srv.command}"\n`;
        toml += `args = ${JSON.stringify(srv.args || [])}\n`;
        if (srv.env && Object.keys(srv.env).length) {
            toml += `[mcp_servers.${name}.env]\n`;
            for (const [k, v] of Object.entries(srv.env)) {
                toml += `${k} = "${v}"\n`;
            }
        }
        toml += '\n';
    }
    return toml;
}

/** → OpenCode opencode.json mcp block */
export function toOpenCodeMcp(config: Record<string, any>) {
    const mcp: Record<string, any> = {};
    for (const [name, srv] of Object.entries(config.servers || {}) as [string, any][]) {
        (mcp as Record<string, any>)[name] = {
            type: 'local',
            command: [srv.command, ...(srv.args || [])],
        };
        if (srv.env && Object.keys(srv.env).length) (mcp as Record<string, any>)[name].environment = srv.env;
    }
    return mcp;
}

// ─── Patch helpers ─────────────────────────────────

/** Replace only [mcp_servers.*] sections in existing TOML, keep everything else */
export function patchCodexToml(existingToml: string, newMcpToml: string) {
    const lines = existingToml.split('\n');
    const output = [];
    let inMcp = false;

    for (const line of lines) {
        if (/^\[mcp_servers\./.test(line)) {
            inMcp = true;
            continue;
        }
        if (inMcp && /^\[/.test(line) && !/^\[mcp_servers\./.test(line)) {
            inMcp = false;
        }
        if (!inMcp) output.push(line);
    }

    // Remove trailing blank lines before appending MCP section
    while (output.length && output[output.length - 1]!.trim() === '') output.pop();
    return output.join('\n') + '\n\n' + newMcpToml;
}

/** Patch JSON file — merge a block into existing JSON without losing other keys */
function patchJsonFile(filePath: string, patchObj: Record<string, any>) {
    let existing: Record<string, any> = {};
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>; } catch { }
    const merged = { ...existing, ...patchObj };
    fs.mkdirSync(dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 4) + '\n');
}

// ─── Sync to all targets ──────────────────────────

/**
 * Sync unified MCP config to all CLI config files (global paths only).
 * @param {Object} config - Unified MCP config { servers: {...} }
 */
export function syncToAll(config: Record<string, any>) {
    const results = { claude: false, codex: false, gemini: false, opencode: false, copilot: false, antigravity: false };

    // 1. Claude Code: ~/.mcp.json (global)
    try {
        const claudePath = join(os.homedir(), '.mcp.json');
        const claudeData = toClaudeMcp(config);
        // Merge with existing (keep other keys if any)
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as Record<string, any>; } catch { }
        existing.mcpServers = claudeData.mcpServers;
        fs.writeFileSync(claudePath, JSON.stringify(existing, null, 4) + '\n');
        results.claude = true;
        console.log(`[mcp-sync] ✅ Claude: ${claudePath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Claude:`, (e as Error).message); }

    // 2. Codex: ~/.codex/config.toml
    try {
        const codexPath = join(os.homedir(), '.codex', 'config.toml');
        if (fs.existsSync(codexPath)) {
            const existing = fs.readFileSync(codexPath, 'utf8');
            const mcpToml = toCodexToml(config);
            fs.writeFileSync(codexPath, patchCodexToml(existing, mcpToml));
            results.codex = true;
            console.log(`[mcp-sync] ✅ Codex: ${codexPath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ Codex: config.toml not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Codex:`, (e as Error).message); }

    // 3. Gemini CLI: ~/.gemini/settings.json
    try {
        const geminiPath = join(os.homedir(), '.gemini', 'settings.json');
        if (fs.existsSync(geminiPath)) {
            const geminiData = toClaudeMcp(config);
            patchJsonFile(geminiPath, { mcpServers: geminiData.mcpServers });
            results.gemini = true;
            console.log(`[mcp-sync] ✅ Gemini: ${geminiPath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ Gemini: settings.json not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Gemini:`, (e as Error).message); }

    // 4. OpenCode: ~/.config/opencode/opencode.json
    try {
        const opencodePath = join(os.homedir(), '.config', 'opencode', 'opencode.json');
        if (fs.existsSync(opencodePath)) {
            const ocMcp = toOpenCodeMcp(config);
            patchJsonFile(opencodePath, { mcp: ocMcp });
            results.opencode = true;
            console.log(`[mcp-sync] ✅ OpenCode: ${opencodePath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ OpenCode: opencode.json not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ OpenCode:`, (e as Error).message); }

    // 5. Copilot: ~/.copilot/mcp-config.json
    try {
        const copilotDir = join(os.homedir(), '.copilot');
        const copilotPath = join(copilotDir, 'mcp-config.json');
        const copilotData = toClaudeMcp(config); // same format as Claude
        fs.mkdirSync(copilotDir, { recursive: true });
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(fs.readFileSync(copilotPath, 'utf8')) as Record<string, any>; } catch { }
        existing.mcpServers = copilotData.mcpServers;
        fs.writeFileSync(copilotPath, JSON.stringify(existing, null, 4) + '\n');
        results.copilot = true;
        console.log(`[mcp-sync] ✅ Copilot: ${copilotPath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Copilot:`, (e as Error).message); }

    // 6. Antigravity: ~/.gemini/antigravity/mcp_config.json
    try {
        const antigravityPath = join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
        const antigravityData = toClaudeMcp(config); // same mcpServers format
        fs.mkdirSync(dirname(antigravityPath), { recursive: true });
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(fs.readFileSync(antigravityPath, 'utf8')) as Record<string, any>; } catch { }
        existing.mcpServers = antigravityData.mcpServers;
        fs.writeFileSync(antigravityPath, JSON.stringify(existing, null, 4) + '\n');
        results.antigravity = true;
        console.log(`[mcp-sync] ✅ Antigravity: ${antigravityPath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Antigravity:`, (e as Error).message); }

    return results;
}

// ─── Skills symlink helpers (Issue #58: isolated-by-default) ──────

interface SkillsLinkOpts {
    onConflict?: 'skip' | 'backup';
    includeClaude?: boolean;
    allowReplaceManaged?: boolean;
    _homedir?: string;   // test DI — default os.homedir()
    _jawHome?: string;   // test DI — default JAW_HOME
}

function buildLinkReport(links: any[], extra?: Record<string, any>) {
    const summary = links.reduce((acc, item) => {
        const key = item.action || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {} as Record<string, any>);
    return { links, summary, ...extra };
}

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

/**
 * @deprecated Use ensureWorkingDirSkillsLinks or ensureSharedHomeSkillsLinks instead.
 * Kept only for backward compatibility during transition — delegates to new helpers.
 */
export function ensureSkillsSymlinks(workingDir: string, opts: Record<string, any> = {}) {
    // Delegate to working-dir-only helper (isolated-by-default)
    return ensureWorkingDirSkillsLinks(workingDir, {
        onConflict: opts.onConflict === 'skip' ? 'skip' : 'backup',
        includeClaude: true,
    });
}

function createBackupContext(jawHome?: string) {
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

function ensureSymlinkSafe(target: string, linkPath: string, opts: Record<string, any> = {}) {
    const onConflict = opts.onConflict === 'skip' ? 'skip' : 'backup';
    const allowReplaceManaged = opts.allowReplaceManaged === true;
    const jawHome = opts.jawHome as string | undefined;
    const backupContext = opts.backupContext || createBackupContext();
    const absTarget = resolve(target);
    const baseResult = {
        name: opts.name || '',
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
        if ((e as any)?.code !== 'ENOENT') {
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

function movePathToBackup(pathToMove: string, context: Record<string, any>) {
    fs.mkdirSync(context.root, { recursive: true });
    const normalized = pathToMove
        .replace(/^[a-zA-Z]:/, '')
        .replace(/^\/+/, '')
        .replace(/[\\/]/g, '__');

    const baseName = normalized || 'root';
    let backupPath = join(context.root, baseName);
    let n = 1;
    while (fs.existsSync(backupPath)) {
        backupPath = join(context.root, `${baseName}__${n}`);
        n += 1;
    }

    fs.renameSync(pathToMove, backupPath);
    return backupPath;
}

// ─── Default MCP servers ───────────────────────────

const DEFAULT_MCP_SERVERS = {
    context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
    },
};

// Phase 12.1.3: npx package → global binary mapping
const NPX_TO_GLOBAL = {
    '@upstash/context7-mcp': { pkg: '@upstash/context7-mcp', bin: 'context7-mcp' },
};

function resolveNpxPackage(args: any) {
    const pkg = (args || []).find((a: string) => !a.startsWith('-'));
    return pkg ? (NPX_TO_GLOBAL as Record<string, any>)[pkg] : null;
}

/**
 * Phase 12.1.3: Install MCP servers globally.
 * npx-based → npm i -g, uv-based → uv tool install.
 * Returns per-server results.
 */
export async function installMcpServers(config: Record<string, any>) {
    const { execSync, execFileSync } = await import('child_process');
    const results: Record<string, any> = {};
    const pathLookupCmd = process.platform === 'win32' ? 'where' : 'which';
    const findBinary = (name: string) => {
        try {
            const raw = execFileSync(pathLookupCmd, [name], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
            return raw.split(/\r?\n/).map(x => x.trim()).find(Boolean) || name;
        } catch {
            return name;
        }
    };

    for (const [name, srv] of Object.entries(config.servers || {}) as [string, any][]) {
        // Skip already-global servers
        if (srv.command !== 'npx' && srv.command !== 'uv' && srv.command !== 'uvx') {
            (results as Record<string, any>)[name] = { status: 'skip', reason: 'already global' };
            continue;
        }

        try {
            if (srv.command === 'npx') {
                // npm ecosystem
                const info = resolveNpxPackage(srv.args);
                if (!info) { results[name] = { status: 'skip', reason: 'unknown npm pkg' }; continue; }

                console.log(`[mcp:install] npm i -g ${info.pkg} ...`);
                execSync(`npm i -g ${info.pkg}`, { stdio: 'pipe', timeout: 120000 });

                const binPath = findBinary(info.bin);

                srv.command = info.bin;
                srv.args = [];
                results[name] = { status: 'installed', bin: binPath, eco: 'npm' };
                console.log(`[mcp:install] ✅ ${name} → ${binPath}`);

            } else {
                // uv/uvx ecosystem (pypi)
                const pkg = (srv.args || []).find((a: string) => !a.startsWith('-') && !a.startsWith('/'));
                if (!pkg) { results[name] = { status: 'skip', reason: 'no pypi pkg found' }; continue; }

                console.log(`[mcp:install] uv tool install ${pkg} ...`);
                try {
                    execSync(`uv tool install ${pkg}`, { stdio: 'pipe', timeout: 120000 });
                } catch {
                    try { execSync(`uv tool upgrade ${pkg}`, { stdio: 'pipe', timeout: 120000 }); }
                    catch { /* already latest */ }
                }

                const binPath = findBinary(pkg);

                srv.command = binPath || pkg;
                srv.args = [];
                results[name] = { status: 'installed', bin: binPath, eco: 'pypi' };
                console.log(`[mcp:install] ✅ ${name} → ${binPath}`);
            }
        } catch (e: unknown) {
            results[name] = { status: 'error', message: (e as Error).message?.slice(0, 200) };
            console.error(`[mcp:install] ❌ ${name}: ${(e as Error).message?.slice(0, 100)}`);
        }
    }

    return results;
}

// ─── Init: first-time setup ────────────────────────

/**
 * Initialize MCP config if missing.
 * If workingDir has .mcp.json, import and merge with defaults.
 * Otherwise, create config with default servers (context7).
 */
export function initMcpConfig(workingDir: string) {
    if (fs.existsSync(MCP_PATH)) {
        console.log(`[mcp-sync] unified config exists: ${MCP_PATH}`);
        return loadUnifiedMcp();
    }

    let servers = { ...DEFAULT_MCP_SERVERS };

    // Try importing from existing .mcp.json, merge with defaults
    const claudePath = join(workingDir, '.mcp.json');
    if (fs.existsSync(claudePath)) {
        console.log(`[mcp-sync] importing from ${claudePath}`);
        const imported = importFromClaudeMcp(claudePath);
        servers = { ...servers, ...(imported.servers || {}) };
    }

    const config = { servers };
    saveUnifiedMcp(config);
    console.log(`[mcp-sync] initialized with ${Object.keys(servers).length} servers: ${Object.keys(servers).join(', ')}`);
    return config;
}

// ─── Version helpers ────────────────────────────────

function semverGt(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
        if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
    }
    return false;
}

function loadRegistry(dir: string): Record<string, any> {
    try {
        return JSON.parse(fs.readFileSync(join(dir, 'registry.json'), 'utf8'));
    } catch { return { skills: {} }; }
}

// ─── Skill activation sets (shared by copyDefaultSkills / softResetSkills) ───
const CODEX_ACTIVE = new Set([
    'pdf',
]);

const OPENCLAW_ACTIVE = new Set([
    'browser', 'notion', 'memory', 'vision-click',
    'screen-capture', 'docx', 'xlsx', 'pptx', 'hwp', 'github', 'telegram-send',
    'video', 'pdf-vision', 'diagram',
]);

function getSkillVersion(id: string, registry: any): string | null {
    return registry?.skills?.[id]?.version ?? null;
}

// ─── Skills: copy defaults ─────────────────────────

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

    // ─── Skill sets ─────────────────────────────────
    // CODEX_ACTIVE / OPENCLAW_ACTIVE → module scope (shared with softResetSkills)

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
            const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
            for (const [id, meta] of Object.entries(registry.skills || {}) as [string, any][]) {
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

    // 1a. Try GitHub clone first (public repo, always latest)
    if (shouldSkipClone()) {
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
        } else {
            console.warn(`[skills:soft-reset] ⚠️ no source available — keeping current skills unchanged`);
            return { restored: 0, added: 0 };
        }
    }

    // 2. skills_ref/ 전체를 소스에서 다시 복사 (덮어쓰기)
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const src = join(sourceDir, entry.name);
        const dst = join(refDir, entry.name);
        if (entry.isDirectory()) {
            if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
            copyDirRecursive(src, dst);
        } else if (entry.isFile()) {
            fs.copyFileSync(src, dst);
        }
    }

    // Cleanup temp clone
    if (tmpCloneDir && fs.existsSync(tmpCloneDir)) {
        fs.rmSync(tmpCloneDir, { recursive: true, force: true });
    }

    // 3. active skills → ref에 같은 이름이 있으면 무조건 덮어쓰기
    let restored = 0;
    if (fs.existsSync(activeDir)) {
        for (const d of fs.readdirSync(activeDir, { withFileTypes: true })) {
            if (!d.isDirectory() || d.name.startsWith('.')) continue;
            const src = join(refDir, d.name);
            const dst = join(activeDir, d.name);
            if (!fs.existsSync(src)) continue;  // ref에 없으면 보존 (순수 커스텀)
            fs.rmSync(dst, { recursive: true, force: true });
            copyDirRecursive(src, dst);
            restored++;
        }
    }

    // 4. AUTO_ACTIVATE 중 아직 active에 없는 것 추가
    const autoActivate = new Set([...CODEX_ACTIVE, ...OPENCLAW_ACTIVE]);
    try {
        const regPath = join(refDir, 'registry.json');
        if (fs.existsSync(regPath)) {
            const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
            for (const [id, meta] of Object.entries(reg.skills || {}) as [string, any][]) {
                if (meta.category === 'orchestration') autoActivate.add(id);
            }
        }
    } catch { /* registry parse error — skip */ }
    let added = 0;
    for (const id of autoActivate) {
        const src = join(refDir, id);
        const dst = join(activeDir, id);
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        copyDirRecursive(src, dst);
        added++;
    }

    // 5. Cleanup temp clone
    if (tmpCloneDir && fs.existsSync(tmpCloneDir)) {
        fs.rmSync(tmpCloneDir, { recursive: true, force: true });
    }

    console.log(`[skills:soft-reset] restored=${restored}, added=${added}`);
    return { restored, added };
}

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

    const symlinks = ensureWorkingDirSkillsLinks(repairTargetDir, {
        onConflict: 'skip',
        includeClaude: opts.includeClaude ?? true,
        allowReplaceManaged: true,
        _homedir: opts._homedir,
        _jawHome: jawHome,
    });

    return { symlinks, repairedPaths };
}

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

    const repair = repairManagedSkillLinksAfterReset(options.repairTargetDir, {
        includeClaude: options.includeClaude ?? true,
        _homedir: options._homedir,
        _jawHome: options._jawHome,
    });

    return { mode, ...resetResult, ...repair };
}

/** Recursively copy a directory (symlink-safe, error-resilient) */
function copyDirRecursive(src: string, dst: string) {
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

// ─── Clone cooldown exports (for testing) ───────────
export { shouldSkipClone, writeCloneMeta, readCloneMeta, CLONE_META_PATH, CLONE_COOLDOWN_MS, CLONE_TIMEOUT_MS };
