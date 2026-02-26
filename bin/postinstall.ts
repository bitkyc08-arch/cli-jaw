#!/usr/bin/env node
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
import { JAW_HOME } from '../src/core/config.js';

const home = os.homedir();
const jawHome = JAW_HOME;
const PATH_LOOKUP_CMD = process.platform === 'win32' ? 'where' : 'which';

// ─── Legacy migration: ~/.cli-jaw → jawHome ───
// Only run when jawHome IS the default (~/.cli-jaw). Custom --home must never move default data.
const legacyHome = path.join(home, '.cli-jaw');
const isDefaultHome = jawHome === legacyHome;

if (isDefaultHome && fs.existsSync(legacyHome) && !fs.existsSync(jawHome)) {
    console.log(`[jaw:init] migrating ~/.cli-jaw → ${jawHome} ...`);
    fs.renameSync(legacyHome, jawHome);
    console.log(`[jaw:init] ✅ migration complete`);
} else if (isDefaultHome && fs.existsSync(legacyHome) && fs.existsSync(jawHome)) {
    console.log(`[jaw:init] ⚠️ both ~/.cli-jaw and ~/.cli-jaw exist — using ~/.cli-jaw`);
}

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

// 1. Ensure ~/.cli-jaw/ directories
ensureDir(jawHome);
ensureDir(path.join(jawHome, 'skills'));
ensureDir(path.join(jawHome, 'uploads'));

// 2. Skills symlinks (home-based default)
const skillsSymlinkReport = ensureSkillsSymlinks(home, { onConflict: 'backup' });
logSkillsSymlinkReport(skillsSymlinkReport);

// 2b. Auto-install 5 CLI tools (bun preferred, npm fallback)
const hasBun = (() => { try { execSync('bun --version', { stdio: 'pipe' }); return true; } catch { return false; } })();
const installGlobal = hasBun ? 'bun install -g' : 'npm i -g';
const installLabel = hasBun ? 'bun' : 'npm';

const CLI_PACKAGES = [
    { bin: 'claude', pkg: '@anthropic-ai/claude-code' },
    { bin: 'codex', pkg: '@openai/codex' },
    { bin: 'gemini', pkg: '@google/gemini-cli' },
    { bin: 'opencode', pkg: 'opencode-ai' },
];

console.log(`[jaw:init] checking CLI tools (using ${installLabel})...`);
for (const { bin, pkg } of CLI_PACKAGES) {
    if (findBinaryPath(bin)) {
        console.log(`[jaw:init] ⏭️  ${bin} (already installed)`);
        continue;
    }

    console.log(`[jaw:init] 📦 ${installGlobal} ${pkg} ...`);
    try {
        execSync(`${installGlobal} ${pkg}`, { stdio: 'pipe', timeout: 180000 });
        console.log(`[jaw:init] ✅ ${bin} installed`);
    } catch {
        // Fallback: if bun failed, try npm
        if (hasBun) {
            console.log(`[jaw:init] ⚠️  bun failed, trying npm i -g ${pkg} ...`);
            try {
                execSync(`npm i -g ${pkg}`, { stdio: 'pipe', timeout: 180000 });
                console.log(`[jaw:init] ✅ ${bin} installed (via npm fallback)`);
            } catch {
                console.error(`[jaw:init] ⚠️  ${bin}: auto-install failed — install manually: npm i -g ${pkg}`);
            }
        } else {
            console.error(`[jaw:init] ⚠️  ${bin}: auto-install failed — install manually: npm i -g ${pkg}`);
        }
    }
}

// 2c. Copilot CLI: gh extension + PATH symlink
try {
    const copilotBin = path.join(home, '.local', 'share', 'gh', 'copilot', 'copilot');
    if (!fs.existsSync(copilotBin)) {
        console.log('[jaw:init] 📦 Installing Copilot CLI via gh...');
        execSync('gh copilot --help', { stdio: 'ignore', timeout: 30000 });
    }
    if (fs.existsSync(copilotBin)) {
        ensureDir(path.join(home, '.local', 'bin'));
        ensureSymlink(copilotBin, path.join(home, '.local', 'bin', 'copilot'));
        console.log('[jaw:init] ✅ copilot installed');
    }
} catch { console.log('[jaw:init] ⚠️ copilot: gh not authenticated — run: 1) gh auth login → 2) gh copilot --help → 3) copilot login'); }


// 3. ~/CLAUDE.md → ~/AGENTS.md (if AGENTS.md exists and CLAUDE.md doesn't)
const agentsMd = path.join(jawHome, 'AGENTS.md');
const claudeMd = path.join(jawHome, 'CLAUDE.md');
if (fs.existsSync(agentsMd) && !fs.existsSync(claudeMd)) {
    ensureSymlink(agentsMd, claudeMd);
}

// 4. Ensure default heartbeat.json if missing
const heartbeatPath = path.join(jawHome, 'heartbeat.json');
if (!fs.existsSync(heartbeatPath)) {
    fs.writeFileSync(heartbeatPath, JSON.stringify({ jobs: [] }, null, 2));
    console.log(`[jaw:init] created ${heartbeatPath}`);
}

// 5. Initialize unified MCP config (import from existing .mcp.json if found)
initMcpConfig(home);

// 6. Copy default skills (Codex → ~/.cli-jaw/skills)
copyDefaultSkills();

// 7. Install default MCP servers globally (Phase 12.1.3)
const MCP_PACKAGES = [
    { pkg: '@upstash/context7-mcp', bin: 'context7-mcp' },
];

console.log('[jaw:init] installing MCP servers globally...');
const config = loadUnifiedMcp();
let updated = false;

for (const { pkg, bin } of MCP_PACKAGES) {
    try {
        // Check if already installed
        const installedPath = findBinaryPath(bin);
        if (installedPath) {
            console.log(`[jaw:init] ⏭️  ${bin} (already installed)`);
            continue;
        }

        console.log(`[jaw:init] 📦 npm i -g ${pkg} ...`);
        execSync(`npm i -g ${pkg}`, { stdio: 'pipe', timeout: 120000 });

        const binPath = findBinaryPath(bin) || bin;
        console.log(`[jaw:init] ✅ ${bin} → ${binPath}`);

        // Update mcp.json: npx → direct binary
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

// 8. Auto-install skill dependencies (Phase 9)
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

console.log('[jaw:init] checking skill dependencies...');
for (const dep of SKILL_DEPS) {
    try {
        execSync(dep.check, { stdio: 'pipe', timeout: 10000 });
        console.log(`[jaw:init] ⏭️  ${dep.name} (already installed)`);
    } catch {
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

console.log('[jaw:init] setup complete ✅');
