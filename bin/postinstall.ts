#!/usr/bin/env node

// ─── Node version guard ─────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major! < 22) {
    console.error(`[jaw:init] ❌ Node.js >= 22 required (current: ${process.version})`);
    console.error(`[jaw:init]    Install: https://nodejs.org or nvm install 22`);
    process.exit(1);
}

/**
 * postinstall.js — Phase 12.1
 * Sets up symlink structure and MCP config for agent tool compatibility.
 *
 * Created structure (isolated-by-default):
 *   ~/.cli-jaw/           (config dir)
 *   ~/.cli-jaw/skills/    (default skills source)
 *   ~/.cli-jaw/uploads/   (media uploads)
 *   ~/.cli-jaw/mcp.json   (unified MCP config)
 *
 * Shared home paths (~/.agents, ~/.agent, ~/.claude) are NOT modified by default.
 * Opt-in: CLI_JAW_MIGRATE_SHARED_PATHS=1 npm install -g cli-jaw
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'node:url';
import { ensureSharedHomeSkillsLinks, initMcpConfig, copyDefaultSkills, loadUnifiedMcp, saveUnifiedMcp } from '../lib/mcp-sync.js';

// ─── JAW_HOME inline (config.ts → registry.ts import 체인 제거) ───
const JAW_HOME = process.env.CLI_JAW_HOME
    ? path.resolve(process.env.CLI_JAW_HOME.replace(/^~(?=\/|$)/, os.homedir()))
    : path.join(os.homedir(), '.cli-jaw');

const home = os.homedir();
const jawHome = JAW_HOME;
const PATH_LOOKUP_CMD = process.platform === 'win32' ? 'where' : 'which';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = fs.existsSync(path.join(MODULE_DIR, '..', '..', 'scripts'))
    ? path.resolve(MODULE_DIR, '..', '..')
    : path.resolve(MODULE_DIR, '..');
const OFFICECLI_DEFAULT_REPO = 'lidge-jun/OfficeCLI';
const OFFICECLI_SKIP = process.env.CLI_JAW_SKIP_OFFICECLI === '1'
    || process.env.CLI_JAW_SKIP_OFFICECLI === 'true';
const OFFICECLI_FORCE = process.env.CLI_JAW_FORCE_OFFICECLI === '1'
    || process.env.CLI_JAW_FORCE_OFFICECLI === 'true';

// ─── Legacy migration ───
// Moved into runPostinstall() to prevent side effects on dynamic import.
// (init.ts imports this module for installCliTools/etc — must not trigger fs.renameSync)

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[jaw:init] created ${dir}`);
    }
}

function ensureSymlink(target: string, linkPath: string) {
    if (fs.existsSync(linkPath)) return false;
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
        fs.symlinkSync(target, linkPath);
        console.log(`[jaw:init] symlink: ${linkPath} → ${target}`);
        return true;
    } catch (e: any) {
        if (process.platform === 'win32' && (e?.code === 'EPERM' || e?.code === 'UNKNOWN')) {
            try {
                const stat = fs.statSync(target);
                if (stat.isDirectory()) {
                    fs.symlinkSync(target, linkPath, 'junction');
                } else {
                    fs.copyFileSync(target, linkPath);
                }
                console.log(`[jaw:init] fallback link: ${linkPath} → ${target}`);
                return true;
            } catch (fallbackErr: any) {
                console.error(`[jaw:init] ⚠️ symlink fallback failed: ${linkPath} (${fallbackErr?.message || 'unknown'})`);
                return false;
            }
        }
        console.error(`[jaw:init] ⚠️ symlink failed: ${linkPath} (${e?.message || 'unknown'})`);
        return false;
    }
}

function findBinaryPath(name: string): string | null {
    try {
        const out = execFileSync(PATH_LOOKUP_CMD, [name], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
        const first = out.split(/\r?\n/).map(x => x.trim()).find(Boolean);
        return first || null;
    } catch {
        return null;
    }
}

function logSkillsSymlinkReport(report: any) {
    if (!report?.links) return;

    const moved = report.links.filter((x: any) => x.action === 'backup_replace');
    if (moved.length) {
        console.log(`[jaw:init] skills conflicts moved to backup: ${moved.length}`);
        for (const item of moved) {
            if (item.backupPath) {
                console.log(`[jaw:init]   - ${item.linkPath} -> ${item.backupPath}`);
            }
        }
    }

    const errors = report.links.filter((x: any) => x.status === 'error');
    for (const item of errors) {
        console.log(`[jaw:init] ⚠️ symlink error: ${item.linkPath} (${item.message || 'unknown'})`);
    }
}

const CODEx_COMPUTER_USE_CACHE_ROOT = path.join(
    home,
    '.codex',
    'plugins',
    'cache',
    'openai-bundled',
    'computer-use',
);
const CODEx_COMPUTER_USE_APP_NAME = 'Codex Computer Use.app';
const APPLICATIONS_DIR = '/Applications';
const LSREGISTER_PATH = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function findLatestCodexComputerUseApp(): string | null {
    if (process.platform !== 'darwin' || !fs.existsSync(CODEx_COMPUTER_USE_CACHE_ROOT)) return null;

    try {
        const versions = fs.readdirSync(CODEx_COMPUTER_USE_CACHE_ROOT, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

        for (const version of versions) {
            const appPath = path.join(CODEx_COMPUTER_USE_CACHE_ROOT, version, CODEx_COMPUTER_USE_APP_NAME);
            if (fs.existsSync(appPath)) return appPath;
        }
    } catch (error: any) {
        console.warn(`[jaw:init] ⚠️  failed to inspect Codex Computer Use cache (${error?.message || 'unknown'})`);
    }

    return null;
}

function ensureCodexComputerUseAppInstall() {
    if (process.platform !== 'darwin') return;

    const sourceApp = findLatestCodexComputerUseApp();
    if (!sourceApp) {
        console.log('[jaw:init] ⏭️  Codex Computer Use.app not found in cache — skipped');
        return;
    }

    const targetApp = path.join(APPLICATIONS_DIR, CODEx_COMPUTER_USE_APP_NAME);
    try {
        ensureDir(APPLICATIONS_DIR);

        if (fs.existsSync(targetApp)) {
            const stat = fs.lstatSync(targetApp);
            if (stat.isSymbolicLink()) {
                const backupPath = `${targetApp}.symlink-backup-${Date.now()}`;
                fs.renameSync(targetApp, backupPath);
                console.log(`[jaw:init] moved existing symlink to backup: ${backupPath}`);
            } else {
                fs.rmSync(targetApp, { recursive: true, force: true });
                console.log(`[jaw:init] removed existing app bundle: ${targetApp}`);
            }
        }

        fs.cpSync(sourceApp, targetApp, { recursive: true, dereference: true });
        console.log(`[jaw:init] copied ${CODEx_COMPUTER_USE_APP_NAME} to ${targetApp}`);

        try {
            execFileSync('xattr', ['-dr', 'com.apple.quarantine', targetApp], { stdio: 'pipe', timeout: 10000 });
        } catch {
            // The app is typically notarized already; quarantine may not be present.
        }

        if (fs.existsSync(LSREGISTER_PATH)) {
            execFileSync(LSREGISTER_PATH, ['-f', '-R', targetApp], { stdio: 'pipe', timeout: 15000 });
            console.log(`[jaw:init] registered ${CODEx_COMPUTER_USE_APP_NAME} with Launch Services`);
        }
    } catch (error: any) {
        console.warn(`[jaw:init] ⚠️  failed to install ${CODEx_COMPUTER_USE_APP_NAME} (${error?.message || 'unknown'})`);
    }
}

// ─── Exported install functions (module-level, no side effects) ─────

export type InstallOpts = {
    dryRun?: boolean;
    interactive?: boolean;
    ask?: (question: string, defaultVal: string) => Promise<string>;
};

export async function installOfficeCli(opts: InstallOpts = {}) {
    if (OFFICECLI_SKIP) {
        console.log('[jaw:init] ⏭️  officecli skipped (CLI_JAW_SKIP_OFFICECLI)');
        return;
    }

    const repo = process.env.OFFICECLI_REPO || OFFICECLI_DEFAULT_REPO;
    if (opts.interactive && opts.ask) {
        const answer = await opts.ask(`Install/update OfficeCLI (${repo})? [Y/n]`, 'y');
        if (answer.toLowerCase() === 'n') {
            console.log('[jaw:init] ⏭️  skipped officecli');
            return;
        }
    }

    if (process.platform === 'win32') {
        const ps = findBinaryPath('pwsh') || findBinaryPath('powershell');
        const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'install-officecli.ps1');
        if (!ps || !fs.existsSync(scriptPath)) {
            console.log('[jaw:init] ⚠️  officecli installer unavailable on win32 — skipped');
            return;
        }
        const args = ps.toLowerCase().includes('powershell')
            ? ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Update']
            : ['-File', scriptPath, '-Update'];
        if (OFFICECLI_FORCE) args.push('-Force');
        if (repo !== OFFICECLI_DEFAULT_REPO) args.push('-Repo', repo);
        if (opts.dryRun) {
            console.log(`  [dry-run] would run ${ps} ${args.join(' ')}`);
            return;
        }
        console.log(`[jaw:init] 📦 ensuring officecli (${repo}) via PowerShell installer...`);
        try {
            execFileSync(ps, args, { stdio: 'inherit', timeout: 180000, env: process.env });
        } catch (e: any) {
            console.warn(`[jaw:init] ⚠️  officecli install failed (exit ${e.status ?? '?'}); skipping — run manually: install-officecli.sh`);
        }
        return;
    }

    const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'install-officecli.sh');
    if (!fs.existsSync(scriptPath)) {
        console.log('[jaw:init] ⚠️  officecli installer script not found — skipped');
        return;
    }
    const args = [scriptPath, '--update'];
    if (OFFICECLI_FORCE) args.push('--force');
    if (opts.dryRun) {
        console.log(`  [dry-run] would run bash ${args.join(' ')}`);
        return;
    }
    console.log(`[jaw:init] 📦 ensuring officecli (${repo}) via shell installer...`);
    try {
        execFileSync('bash', args, {
            stdio: 'inherit',
            timeout: 180000,
            env: { ...process.env, OFFICECLI_REPO: repo },
        });
    } catch (e: any) {
        console.warn(`[jaw:init] ⚠️  officecli install failed (exit ${e.status ?? '?'}); skipping — run manually: bash scripts/install-officecli.sh`);
    }
}

const CLI_PACKAGES: { bin: string; pkg: string; brew?: string; forceMgr?: PkgMgr }[] = [
    { bin: 'claude', pkg: '@anthropic-ai/claude-code' },
    { bin: 'codex', pkg: '@openai/codex' },
    { bin: 'gemini', pkg: '@google/gemini-cli', brew: 'gemini-cli' },
    { bin: 'copilot', pkg: '@github/copilot', forceMgr: 'npm' },
    { bin: 'opencode', pkg: 'opencode-ai' },
];

type PkgMgr = 'bun' | 'npm' | 'brew';

/** Detect which package manager originally installed a binary. */
function detectInstaller(binName: string): PkgMgr | null {
    try {
        const binPath = execSync(`${PATH_LOOKUP_CMD} ${binName}`, {
            encoding: 'utf8', stdio: 'pipe', timeout: 3000,
        }).trim().split(/\r?\n/)[0]!;
        if (binPath.includes('/.bun/')) return 'bun';
        if (binPath.includes('/Cellar/') || binPath.includes('/homebrew/')) return 'brew';
        // npm: check against npm global prefix or nvm paths
        try {
            const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', stdio: 'pipe', timeout: 3000 }).trim();
            if (binPath.startsWith(npmPrefix)) return 'npm';
        } catch { /* npm unavailable */ }
        if (binPath.includes('/.nvm/') || binPath.includes('/nodejs/')) return 'npm';
        return null;
    } catch {
        return null; // binary not found
    }
}

/** Detect the default package manager for fresh installs. */
function detectDefaultPkgMgr(): Exclude<PkgMgr, 'brew'> {
    try { execSync('bun --version', { stdio: 'pipe' }); return 'bun'; } catch { return 'npm'; }
}

function buildInstallCmd(mgr: PkgMgr, pkg: string, brewFormula?: string): string {
    switch (mgr) {
        case 'brew': return `brew upgrade ${brewFormula || pkg} 2>/dev/null || brew install ${brewFormula || pkg}`;
        case 'bun':  return `bun install -g ${pkg}@latest`;
        case 'npm':  return `npm i -g ${pkg}@latest`;
    }
}

/** Check if a package is installed via a specific manager (independent of PATH order). */
function isInstalledVia(mgr: PkgMgr, pkg: string, brewFormula?: string): boolean {
    try {
        switch (mgr) {
            case 'npm':
                execSync(`npm ls -g ${pkg} --depth=0`, { stdio: 'pipe', timeout: 5000 });
                return true;
            case 'bun': {
                const bunGlobal = path.join(home, '.bun', 'install', 'global', 'node_modules', pkg.split('/').pop()!);
                return fs.existsSync(bunGlobal);
            }
            case 'brew':
                execSync(`brew list --formula ${brewFormula || pkg}`, { stdio: 'pipe', timeout: 5000 });
                return true;
        }
    } catch { return false; }
}

function buildUninstallCmd(mgr: PkgMgr, pkg: string, brewFormula?: string): string {
    switch (mgr) {
        case 'npm':  return `npm uninstall -g ${pkg}`;
        case 'bun':  return `bun remove -g ${pkg}`;
        case 'brew': return `brew uninstall ${brewFormula || pkg}`;
    }
}

/** Remove duplicate installations — keep the active one (PATH winner), remove the rest. */
function deduplicateCliTool(bin: string, pkg: string, brew?: string): void {
    const active = detectInstaller(bin);
    if (!active) return; // not installed at all
    const others: PkgMgr[] = (['bun', 'npm', 'brew'] as const).filter(m => m !== active);
    for (const mgr of others) {
        if (!isInstalledVia(mgr, pkg, brew)) continue;
        const cmd = buildUninstallCmd(mgr, pkg, brew);
        console.log(`[jaw:init] 🧹 ${bin}: removing duplicate from ${mgr} (active: ${active})`);
        try {
            execSync(cmd, { stdio: 'pipe', timeout: 30000 });
            console.log(`[jaw:init]    removed ${pkg} from ${mgr}`);
        } catch {
            console.warn(`[jaw:init]    ⚠️  failed to remove ${pkg} from ${mgr} — remove manually: ${cmd}`);
        }
    }
}

export async function installCliTools(opts: InstallOpts = {}) {
    const defaultMgr = detectDefaultPkgMgr();

    console.log('[jaw:init] installing CLI tools @latest...');
    for (const { bin, pkg, brew, forceMgr } of CLI_PACKAGES) {
        if (opts.dryRun) { console.log(`  [dry-run] would install ${pkg}`); continue; }
        if (opts.interactive && opts.ask) {
            const answer = await opts.ask(`Install ${bin} (${pkg})? [y/N]`, 'n');
            if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${bin}`); continue; }
        }
        // forceMgr overrides detection (e.g. copilot → always npm)
        const existing = forceMgr ? null : detectInstaller(bin);
        const mgr = forceMgr || existing || defaultMgr;
        const cmd = buildInstallCmd(mgr, pkg, brew);
        const tag = existing ? `update via ${mgr}` : `fresh install via ${mgr}`;
        console.log(`[jaw:init] 📦 ${bin} (${tag}): ${cmd}`);
        try {
            execSync(cmd, { stdio: 'pipe', timeout: 180000 });
            console.log(`[jaw:init] ✅ ${bin} installed`);
        } catch {
            // Fallback: if preferred manager failed and it wasn't npm, try npm
            if (mgr !== 'npm') {
                console.log(`[jaw:init] ⚠️  ${mgr} failed, trying npm i -g ${pkg}@latest ...`);
                try {
                    execSync(`npm i -g ${pkg}@latest`, { stdio: 'pipe', timeout: 180000 });
                    console.log(`[jaw:init] ✅ ${bin} installed (via npm fallback)`);
                } catch {
                    console.error(`[jaw:init] ⚠️  ${bin}: auto-install failed — install manually: npm i -g ${pkg}`);
                }
            } else {
                console.error(`[jaw:init] ⚠️  ${bin}: auto-install failed — install manually: npm i -g ${pkg}`);
            }
        }
        // Clean up duplicate installations from other package managers
        deduplicateCliTool(bin, pkg, brew);
    }
}

const MCP_PACKAGES = [
    { pkg: '@upstash/context7-mcp', bin: 'context7-mcp' },
];

export async function installMcpServers(opts: InstallOpts = {}) {
    console.log('[jaw:init] installing MCP servers globally...');
    const config = loadUnifiedMcp();
    let updated = false;

    for (const { pkg, bin } of MCP_PACKAGES) {
        try {
            const installedPath = findBinaryPath(bin);
            if (installedPath) {
                console.log(`[jaw:init] ⏭️  ${bin} (already installed)`);
                continue;
            }
            if (opts.dryRun) { console.log(`  [dry-run] would install ${pkg}`); continue; }
            if (opts.interactive && opts.ask) {
                const answer = await opts.ask(`Install MCP server ${bin} (${pkg})? [y/N]`, 'n');
                if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${bin}`); continue; }
            }

            console.log(`[jaw:init] 📦 npm i -g ${pkg} ...`);
            execSync(`npm i -g ${pkg}`, { stdio: 'pipe', timeout: 120000 });

            const binPath = findBinaryPath(bin) || bin;
            console.log(`[jaw:init] ✅ ${bin} → ${binPath}`);

            for (const [name, srv] of Object.entries(config.servers || {}) as [string, any][]) {
                if (srv.command === 'npx' && (srv.args || []).includes(pkg)) {
                    srv.command = bin;
                    srv.args = [];
                    updated = true;
                }
            }
        } catch (e) {
            console.error(`[jaw:init] ⚠️  ${pkg}: ${(e as Error).message?.slice(0, 80)}`);
        }
    }

    if (updated) saveUnifiedMcp(config);
}

const SKILL_DEPS = [
    {
        name: 'uv',
        check: 'uv --version',
        install: process.platform === 'win32'
            ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
            : 'curl -LsSf https://astral.sh/uv/install.sh | sh',
        why: 'Python skills (imagegen, pdf, speech, spreadsheet, transcribe)',
    },
    {
        name: 'playwright-core',
        check: 'node -e "require.resolve(\'playwright-core\')"',
        install: 'npm i -g playwright-core',
        why: 'Browser control skill (cli-jaw browser)',
    },
];

export async function installSkillDeps(opts: InstallOpts = {}) {
    console.log('[jaw:init] checking skill dependencies...');
    for (const dep of SKILL_DEPS) {
        try {
            execSync(dep.check, { stdio: 'pipe', timeout: 10000 });
            console.log(`[jaw:init] ⏭️  ${dep.name} (already installed)`);
        } catch {
            if (opts.dryRun) { console.log(`  [dry-run] would install ${dep.name} (${dep.why})`); continue; }
            if (opts.interactive && opts.ask) {
                const answer = await opts.ask(`Install ${dep.name} (${dep.why})? [y/N]`, 'n');
                if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${dep.name}`); continue; }
            }
            console.log(`[jaw:init] 📦 installing ${dep.name} (${dep.why})...`);
            try {
                execSync(dep.install, { stdio: 'pipe', timeout: 120000 });
                console.log(`[jaw:init] ✅ ${dep.name} installed`);
            } catch (e) {
                console.error(`[jaw:init] ⚠️  ${dep.name}: auto-install failed — install manually:`);
                console.error(`             ${dep.install}`);
            }
        }
    }
}

// ─── runPostinstall: setup + install (no top-level side effects) ────
// Called only when running as npm postinstall entry point.
// Dynamic import from init.ts gets clean library exports only.
export async function runPostinstall() {
    // ── Safe mode guard (before ANY side effects) ──
    const isSafeMode = process.env.npm_config_jaw_safe === '1'
        || process.env.npm_config_jaw_safe === 'true'
        || process.env.JAW_SAFE === '1'
        || process.env.JAW_SAFE === 'true';

    // 1. Ensure ~/.cli-jaw/ home directory
    ensureDir(jawHome);

    if (isSafeMode) {
        console.log('[jaw:postinstall] 🔒 safe mode — home directory created only');
        console.log('[jaw:postinstall] Run `jaw init` to configure interactively');
        return;
    }

    // ── Legacy migration (only in normal mode, NOT safe mode) ──
    const legacyHome = path.join(home, '.cli-jaw');
    const isCustomHome = jawHome !== legacyHome;
    if (isCustomHome && fs.existsSync(legacyHome) && !fs.existsSync(jawHome)) {
        console.log(`[jaw:init] migrating ~/.cli-jaw → ${jawHome} ...`);
        fs.renameSync(legacyHome, jawHome);
        console.log(`[jaw:init] ✅ migration complete`);
    } else if (isCustomHome && fs.existsSync(legacyHome) && fs.existsSync(jawHome)) {
        console.log(`[jaw:init] ⚠️ both ~/.cli-jaw and ${jawHome} exist — using ${jawHome}`);
    }

    // 2. Ensure sub-directories (only in normal mode)
    ensureDir(path.join(jawHome, 'skills'));
    ensureDir(path.join(jawHome, 'uploads'));

    // 2. Skills symlinks — isolated-by-default (Issue #58)
    // No workingDir compat links in postinstall.
    // Postinstall must remain isolated to ~/.cli-jaw/* only.
    const shouldMigrateSharedPaths =
        process.env.CLI_JAW_MIGRATE_SHARED_PATHS === '1'
        || process.env.CLI_JAW_MIGRATE_SHARED_PATHS === 'true'
        || process.env.npm_config_jaw_migrate_shared_paths === '1'
        || process.env.npm_config_jaw_migrate_shared_paths === 'true';

    if (shouldMigrateSharedPaths) {
        const sharedReport = ensureSharedHomeSkillsLinks({
            onConflict: 'backup',
            includeAgents: true,
            includeCompatAgent: true,
            includeClaude: true,
        });
        logSkillsSymlinkReport(sharedReport);
    } else {
        console.log('[jaw:init] shared path migration skipped (isolated-by-default)');
        console.log('[jaw:init] to opt in: CLI_JAW_MIGRATE_SHARED_PATHS=1 npm install -g cli-jaw');
    }

    // 3. CLAUDE.md → AGENTS.md symlink
    const agentsMd = path.join(jawHome, 'AGENTS.md');
    const claudeMd = path.join(jawHome, 'CLAUDE.md');
    if (fs.existsSync(agentsMd) && !fs.existsSync(claudeMd)) {
        ensureSymlink(agentsMd, claudeMd);
    }

    // 4. Default heartbeat.json
    const heartbeatPath = path.join(jawHome, 'heartbeat.json');
    if (!fs.existsSync(heartbeatPath)) {
        fs.writeFileSync(heartbeatPath, JSON.stringify({ jobs: [] }, null, 2));
        console.log(`[jaw:init] created ${heartbeatPath}`);
    }

    // 5. MCP config
    initMcpConfig(home);

    // 6. Default skills
    copyDefaultSkills();

    // 7-9. Install CLI tools, MCP servers, skill deps, officecli runtime
    await installCliTools();
    await installMcpServers();
    await installSkillDeps();
    await installOfficeCli();
    ensureCodexComputerUseAppInstall();
    console.log('[jaw:init] setup complete ✅');
}

// Auto-run only when executed as CLI entry point (not imported)
const isEntryPoint = process.argv[1]?.endsWith('postinstall.js')
    || process.argv[1]?.endsWith('postinstall.ts');
if (isEntryPoint) {
    runPostinstall().catch(e => { console.error(e); process.exit(1); });
}
