/**
 * lib/mcp-sync.js — Phase 12.1
 * Unified MCP config → CLI-specific format conversion.
 * Source of truth: ~/.cli-jaw/mcp.json
 *
 * Supported targets:
 *   Claude Code  → {workingDir}/.mcp.json        (JSON, mcpServers)
 *   Codex        → ~/.codex/config.toml           (TOML, [mcp_servers.name])
 *   Gemini CLI   → ~/.gemini/settings.json        (JSON, mcpServers)
 *   OpenCode     → ~/.config/opencode/opencode.json (JSON, mcp block)
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
 * Sync unified MCP config to all CLI config files.
 * @param {Object} config - Unified MCP config { servers: {...} }
 * @param {string} workingDir - Current working directory for project-scoped files
 */
export function syncToAll(config: Record<string, any>, workingDir: string) {
    const results = { claude: false, codex: false, gemini: false, opencode: false, copilot: false };

    // 1. Claude Code: {workingDir}/.mcp.json
    try {
        const claudePath = join(workingDir, '.mcp.json');
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

    return results;
}

// ─── Skills symlink helper ─────────────────────────

/**
 * Ensure {workingDir}/.agents/skills → ~/.cli-jaw/skills
 * Also ensure ~/.agent/skills → ~/.agents/skills (compat)
 * Also ensure {workingDir}/.claude/skills + ~/.claude/skills (Claude Code CLI)
 */
export function ensureSkillsSymlinks(workingDir: string, opts: Record<string, any> = {}) {
    const onConflict = opts.onConflict === 'skip' ? 'skip' : 'backup';
    const skillsSource = join(JAW_HOME, 'skills');
    fs.mkdirSync(skillsSource, { recursive: true });
    const backupContext = createBackupContext();
    const links = [];

    // 1. {workingDir}/.agents/skills → ~/.cli-jaw/skills
    const wdLink = join(workingDir, '.agents', 'skills');
    links.push(ensureSymlinkSafe(skillsSource, wdLink, { onConflict, backupContext, name: 'wdAgents' }));

    // 2. Home fallback: ~/.agents/skills (if different from workingDir)
    const homeLink = join(os.homedir(), '.agents', 'skills');
    if (homeLink !== wdLink) {
        links.push(ensureSymlinkSafe(skillsSource, homeLink, { onConflict, backupContext, name: 'homeAgents' }));
    } else {
        links.push({
            status: 'skip',
            action: 'same_path',
            name: 'homeAgents',
            linkPath: homeLink,
            target: skillsSource,
        });
    }

    // 3. Compat: ~/.agent/skills → ~/.agents/skills
    const compatLink = join(os.homedir(), '.agent', 'skills');
    links.push(ensureSymlinkSafe(homeLink, compatLink, { onConflict, backupContext, name: 'compatAgent' }));

    // 4. Claude Code CLI: {workingDir}/.claude/skills → ~/.cli-jaw/skills
    const wdClaudeSkills = join(workingDir, '.claude', 'skills');
    links.push(ensureSymlinkSafe(skillsSource, wdClaudeSkills, { onConflict, backupContext, name: 'wdClaude' }));

    // 5. Home Claude Code: ~/.claude/skills → ~/.cli-jaw/skills
    const homeClaudeSkills = join(os.homedir(), '.claude', 'skills');
    if (homeClaudeSkills !== wdClaudeSkills) {
        links.push(ensureSymlinkSafe(skillsSource, homeClaudeSkills, { onConflict, backupContext, name: 'homeClaude' }));
    } else {
        links.push({
            status: 'skip',
            action: 'same_path',
            name: 'homeClaude',
            linkPath: homeClaudeSkills,
            target: skillsSource,
        });
    }

    const summary = links.reduce((acc, item) => {
        const key = item.action || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {} as Record<string, any>);

    return {
        source: skillsSource,
        strategy: onConflict,
        backupRoot: backupContext.root,
        links,
        summary,
    };
}

function createBackupContext() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return { root: join(JAW_HOME, 'backups', 'skills-conflicts', stamp) };
}

function resolveSymlinkTarget(linkPath: string, rawTarget: string) {
    return isAbsolute(rawTarget)
        ? resolve(rawTarget)
        : resolve(dirname(linkPath), rawTarget);
}

function ensureSymlinkSafe(target: string, linkPath: string, opts: Record<string, any> = {}) {
    const onConflict = opts.onConflict === 'skip' ? 'skip' : 'backup';
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
            fs.unlinkSync(linkPath);
            fs.mkdirSync(dirname(linkPath), { recursive: true });
            fs.symlinkSync(target, linkPath);
            console.log(`[skills] symlink(updated): ${linkPath} → ${target}`);
            return {
                ...baseResult,
                status: 'ok',
                action: 'replace_symlink',
                previousTarget: rawTarget,
            };
        }

        if (onConflict === 'skip') {
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
    // Keep this baseline aligned with the expected first-install active set.
    // Phase 1 dedup: screenshot→screen-capture, doc→docx, spreadsheet→xlsx,
    //   gh-address-comments/gh-fix-ci/yeet→github
    const CODEX_ACTIVE = new Set([
        'pdf', 'openai-docs', 'imagegen',
        // frontend-design → dev-frontend으로 대체됨
    ]);

    const OPENCLAW_ACTIVE = new Set([
        'browser', 'notion', 'memory', 'vision-click',
        'screen-capture', 'docx', 'xlsx', 'github', 'telegram-send',  // Phase 1 통합 결과 + Phase 2.2
    ]);


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
    // Priority: bundled (dev) → git clone (npm install) → offline fallback
    const packageRefDir = join(findPackageRoot(), 'skills_ref');
    const SKILLS_REPO = 'https://github.com/lidge-jun/cli-jaw-skills.git';

    if (fs.existsSync(packageRefDir)) {
        // Dev / local: copy from bundled skills_ref/
        const entries = fs.readdirSync(packageRefDir, { withFileTypes: true });
        let refCopied = 0;
        for (const entry of entries) {
            const src = join(packageRefDir, entry.name);
            const dst = join(refDir, entry.name);
            if (entry.isDirectory() && !fs.existsSync(dst)) {
                copyDirRecursive(src, dst);
                refCopied++;
            } else if (entry.isFile()) {
                fs.copyFileSync(src, dst);
            }
        }
        if (refCopied > 0) console.log(`[skills] Bundled: ${refCopied} skills → ref`);
    } else if (!fs.existsSync(join(refDir, 'registry.json'))) {
        // npm install (no bundled dir) + first time (no existing ref)
        // → clone from GitHub
        try {
            // execSync imported at top of file
            console.log(`[skills] cloning skills from ${SKILLS_REPO}...`);
            // Clone into a temp dir, then move contents to refDir (which already exists)
            const tmpClone = join(JAW_HOME, '.skills_clone_tmp');
            if (fs.existsSync(tmpClone)) fs.rmSync(tmpClone, { recursive: true });
            execSync(`git clone --depth 1 ${SKILLS_REPO} "${tmpClone}"`, {
                stdio: 'pipe', timeout: 120000,
            });
            // Move contents (skip .git)
            const cloned = fs.readdirSync(tmpClone, { withFileTypes: true });
            for (const entry of cloned) {
                if (entry.name === '.git') continue;
                const src = join(tmpClone, entry.name);
                const dst = join(refDir, entry.name);
                if (entry.isDirectory() && !fs.existsSync(dst)) {
                    copyDirRecursive(src, dst);
                } else if (entry.isFile()) {
                    fs.copyFileSync(src, dst);
                }
            }
            fs.rmSync(tmpClone, { recursive: true, force: true });
            console.log(`[skills] ✅ cloned skills to ${refDir}`);
        } catch (e) {
            console.warn(`[skills] ⚠️ clone failed: ${(e as Error).message?.slice(0, 80)}`);
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
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
            copyDirRecursive(src, dst);
            copied++;
            autoCount++;
            console.log(`[skills] auto-activated: ${id}`);
        }
    }
    if (autoCount > 0) console.log(`[skills] Total auto-activated: ${autoCount}`);

    return copied;
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
