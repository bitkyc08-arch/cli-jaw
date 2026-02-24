#!/usr/bin/env node
/**
 * postinstall.js — Phase 12.1
 * Sets up symlink structure and MCP config for agent tool compatibility.
 *
 * Created structure:
 *   ~/.cli-claw/           (config dir)
 *   ~/.cli-claw/skills/    (default skills source)
 *   ~/.cli-claw/uploads/   (media uploads)
 *   ~/.cli-claw/mcp.json   (unified MCP config)
 *   {workingDir}/.agents/skills/ → ~/.cli-claw/skills/
 *   ~/.agents/skills/ → ~/.cli-claw/skills/
 *   ~/.agent/skills → ~/.agents/skills
 *   ~/CLAUDE.md → ~/AGENTS.md (if AGENTS.md exists)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { ensureSkillsSymlinks, initMcpConfig, copyDefaultSkills, loadUnifiedMcp, saveUnifiedMcp } from '../lib/mcp-sync.js';

const home = os.homedir();
const clawHome = path.join(home, '.cli-claw');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[claw:init] created ${dir}`);
    }
}

function ensureSymlink(target, linkPath) {
    if (fs.existsSync(linkPath)) return false;
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath);
    console.log(`[claw:init] symlink: ${linkPath} → ${target}`);
    return true;
}

function logSkillsSymlinkReport(report) {
    if (!report?.links) return;

    const moved = report.links.filter(x => x.action === 'backup_replace');
    if (moved.length) {
        console.log(`[claw:init] skills conflicts moved to backup: ${moved.length}`);
        for (const item of moved) {
            if (item.backupPath) {
                console.log(`[claw:init]   - ${item.linkPath} -> ${item.backupPath}`);
            }
        }
    }

    const errors = report.links.filter(x => x.status === 'error');
    for (const item of errors) {
        console.log(`[claw:init] ⚠️ symlink error: ${item.linkPath} (${item.message || 'unknown'})`);
    }
}

// 1. Ensure ~/.cli-claw/ directories
ensureDir(clawHome);
ensureDir(path.join(clawHome, 'skills'));
ensureDir(path.join(clawHome, 'uploads'));

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
    { bin: 'opencode', pkg: 'opencode-antigravity-auth' },
];

console.log(`[claw:init] checking CLI tools (using ${installLabel})...`);
for (const { bin, pkg } of CLI_PACKAGES) {
    try {
        execSync(`which ${bin}`, { stdio: 'pipe' });
        console.log(`[claw:init] ⏭️  ${bin} (already installed)`);
    } catch {
        console.log(`[claw:init] 📦 ${installGlobal} ${pkg} ...`);
        try {
            execSync(`${installGlobal} ${pkg}`, { stdio: 'pipe', timeout: 180000 });
            console.log(`[claw:init] ✅ ${bin} installed`);
        } catch (e) {
            console.error(`[claw:init] ⚠️  ${bin}: auto-install failed — install manually: ${installGlobal} ${pkg}`);
        }
    }
}

// 2c. Copilot CLI: gh extension + PATH symlink
try {
    const copilotBin = path.join(home, '.local', 'share', 'gh', 'copilot', 'copilot');
    if (!fs.existsSync(copilotBin)) {
        console.log('[claw:init] 📦 Installing Copilot CLI via gh...');
        execSync('gh copilot --help', { stdio: 'ignore', timeout: 30000 });
    }
    if (fs.existsSync(copilotBin)) {
        ensureDir(path.join(home, '.local', 'bin'));
        ensureSymlink(copilotBin, path.join(home, '.local', 'bin', 'copilot'));
        console.log('[claw:init] ✅ copilot installed');
    }
} catch { console.log('[claw:init] ⚠️ copilot: gh not authenticated — run: gh auth login'); }


// 3. ~/CLAUDE.md → ~/AGENTS.md (if AGENTS.md exists and CLAUDE.md doesn't)
const agentsMd = path.join(home, 'AGENTS.md');
const claudeMd = path.join(home, 'CLAUDE.md');
if (fs.existsSync(agentsMd) && !fs.existsSync(claudeMd)) {
    ensureSymlink(agentsMd, claudeMd);
}

// 4. Ensure default heartbeat.json if missing
const heartbeatPath = path.join(clawHome, 'heartbeat.json');
if (!fs.existsSync(heartbeatPath)) {
    fs.writeFileSync(heartbeatPath, JSON.stringify({ jobs: [] }, null, 2));
    console.log(`[claw:init] created ${heartbeatPath}`);
}

// 5. Initialize unified MCP config (import from existing .mcp.json if found)
initMcpConfig(home);

// 6. Copy default skills (Codex → ~/.cli-claw/skills)
copyDefaultSkills();

// 7. Install default MCP servers globally (Phase 12.1.3)
const MCP_PACKAGES = [
    { pkg: '@upstash/context7-mcp', bin: 'context7-mcp' },
];

console.log('[claw:init] installing MCP servers globally...');
const config = loadUnifiedMcp();
let updated = false;

for (const { pkg, bin } of MCP_PACKAGES) {
    try {
        // Check if already installed
        try { execSync(`which ${bin}`, { stdio: 'pipe' }); console.log(`[claw:init] ⏭️  ${bin} (already installed)`); continue; }
        catch { /* not installed, proceed */ }

        console.log(`[claw:init] 📦 npm i -g ${pkg} ...`);
        execSync(`npm i -g ${pkg}`, { stdio: 'pipe', timeout: 120000 });

        const binPath = execSync(`which ${bin}`, { encoding: 'utf8', stdio: 'pipe' }).trim();
        console.log(`[claw:init] ✅ ${bin} → ${binPath}`);

        // Update mcp.json: npx → direct binary
        for (const [name, srv] of Object.entries(config.servers || {})) {
            if (srv.command === 'npx' && (srv.args || []).includes(pkg)) {
                srv.command = bin;
                srv.args = [];
                updated = true;
            }
        }
    } catch (e) {
        console.error(`[claw:init] ⚠️  ${pkg}: ${e.message?.slice(0, 80)}`);
    }
}

if (updated) saveUnifiedMcp(config);

// 8. Auto-install skill dependencies (Phase 9)
const SKILL_DEPS = [
    {
        name: 'uv',
        check: 'uv --version',
        install: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
        why: 'Python skills (imagegen, pdf, speech, spreadsheet, transcribe)',
    },
    {
        name: 'playwright-core',
        check: 'node -e "require.resolve(\'playwright-core\')"',
        install: 'npm i -g playwright-core',
        why: 'Browser control skill (cli-claw browser)',
    },
];

console.log('[claw:init] checking skill dependencies...');
for (const dep of SKILL_DEPS) {
    try {
        execSync(dep.check, { stdio: 'pipe', timeout: 10000 });
        console.log(`[claw:init] ⏭️  ${dep.name} (already installed)`);
    } catch {
        console.log(`[claw:init] 📦 installing ${dep.name} (${dep.why})...`);
        try {
            execSync(dep.install, { stdio: 'pipe', timeout: 120000 });
            console.log(`[claw:init] ✅ ${dep.name} installed`);
        } catch (e) {
            console.error(`[claw:init] ⚠️  ${dep.name}: auto-install failed — install manually:`);
            console.error(`             ${dep.install}`);
        }
    }
}

console.log('[claw:init] setup complete ✅');
