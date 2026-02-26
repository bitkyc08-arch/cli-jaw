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
 * Created structure:
 *   ~/.cli-jaw/           (config dir)
 *   ~/.cli-jaw/skills/    (default skills source)
 *   ~/.cli-jaw/uploads/   (media uploads)
 *   ~/.cli-jaw/mcp.json   (unified MCP config)
 *   {workingDir}/.agents/skills/ → ~/.cli-jaw/skills/
 *   ~/.agents/skills/ → ~/.cli-jaw/skills/
 *   ~/.agent/skills → ~/.agents/skills
 *   ~/CLAUDE.md → ~/AGENTS.md (if AGENTS.md exists)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { ensureSkillsSymlinks, initMcpConfig, copyDefaultSkills, loadUnifiedMcp, saveUnifiedMcp } from '../lib/mcp-sync.js';

// ─── JAW_HOME inline (config.ts → registry.ts import 체인 제거) ───
const JAW_HOME = process.env.CLI_JAW_HOME
    ? path.resolve(process.env.CLI_JAW_HOME.replace(/^~(?=\/|$)/, os.homedir()))
    : path.join(os.homedir(), '.cli-jaw');

const home = os.homedir();
const jawHome = JAW_HOME;
const PATH_LOOKUP_CMD = process.platform === 'win32' ? 'where' : 'which';

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

// ─── Exported install functions (module-level, no side effects) ─────

export type InstallOpts = {
    dryRun?: boolean;
    interactive?: boolean;
    ask?: (question: string, defaultVal: string) => Promise<string>;
};

const CLI_PACKAGES = [
    { bin: 'claude', pkg: '@anthropic-ai/claude-code' },
    { bin: 'codex', pkg: '@openai/codex' },
    { bin: 'gemini', pkg: '@google/gemini-cli' },
    { bin: 'copilot', pkg: 'copilot' },
    { bin: 'opencode', pkg: 'opencode-ai' },
];

export async function installCliTools(opts: InstallOpts = {}) {
    const hasBun = (() => { try { execSync('bun --version', { stdio: 'pipe' }); return true; } catch { return false; } })();
    const installGlobal = hasBun ? 'bun install -g' : 'npm i -g';
    const installLabel = hasBun ? 'bun' : 'npm';

    console.log(`[jaw:init] installing CLI tools @latest (using ${installLabel})...`);
    for (const { bin, pkg } of CLI_PACKAGES) {
        if (opts.dryRun) { console.log(`  [dry-run] would install ${pkg}`); continue; }
        if (opts.interactive && opts.ask) {
            const answer = await opts.ask(`Install ${bin} (${pkg})? [y/N]`, 'n');
            if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${bin}`); continue; }
        }
        console.log(`[jaw:init] 📦 ${installGlobal} ${pkg}@latest ...`);
        try {
            execSync(`${installGlobal} ${pkg}@latest`, { stdio: 'pipe', timeout: 180000 });
            console.log(`[jaw:init] ✅ ${bin} installed`);
        } catch {
            if (hasBun) {
                console.log(`[jaw:init] ⚠️  bun failed, trying npm i -g ${pkg}@latest ...`);
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

    // 2. Skills symlinks
    const skillsSymlinkReport = ensureSkillsSymlinks(home, { onConflict: 'backup' });
    logSkillsSymlinkReport(skillsSymlinkReport);

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

    // 7-8. Install CLI tools, MCP servers, skill deps
    await installCliTools();
    await installMcpServers();
    await installSkillDeps();
    console.log('[jaw:init] setup complete ✅');
}

// Auto-run only when executed as CLI entry point (not imported)
const isEntryPoint = process.argv[1]?.endsWith('postinstall.js')
    || process.argv[1]?.endsWith('postinstall.ts');
if (isEntryPoint) {
    runPostinstall().catch(e => { console.error(e); process.exit(1); });
}

