#!/usr/bin/env node
/**
 * postinstall.js — Phase 8.3
 * Sets up symlink structure in workingDir for agent tool compatibility.
 *
 * Created structure:
 *   ~/.cli-claw/           (config dir)
 *   ~/.cli-claw/skills/    (default skills source)
 *   ~/.agents/skills/ → ~/.cli-claw/skills/   (agent compat)
 *   ~/.agent/skills  → ~/.agents/skills       (agent compat)
 *   ~/CLAUDE.md      → ~/AGENTS.md            (if AGENTS.md exists)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const clawHome = path.join(home, '.cli-claw');
const defaultSkillsDir = path.join(clawHome, 'skills');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[claw:init] created ${dir}`);
    }
}

function ensureSymlink(target, linkPath) {
    if (fs.existsSync(linkPath)) {
        // Already exists (file, dir, or symlink) — skip
        return false;
    }
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath);
    console.log(`[claw:init] symlink: ${linkPath} → ${target}`);
    return true;
}

// 1. Ensure ~/.cli-claw/ directories
ensureDir(clawHome);
ensureDir(defaultSkillsDir);

// 2. ~/.agents/skills/ → default skills source (if not already present)
const agentsSkillsDir = path.join(home, '.agents', 'skills');
if (!fs.existsSync(agentsSkillsDir)) {
    ensureSymlink(defaultSkillsDir, agentsSkillsDir);
}

// 3. ~/.agent/skills → ~/.agents/skills (compat symlink)
const agentSkillsLink = path.join(home, '.agent', 'skills');
ensureSymlink(agentsSkillsDir, agentSkillsLink);

// 4. ~/CLAUDE.md → ~/AGENTS.md (if AGENTS.md exists and CLAUDE.md doesn't)
const agentsMd = path.join(home, 'AGENTS.md');
const claudeMd = path.join(home, 'CLAUDE.md');
if (fs.existsSync(agentsMd) && !fs.existsSync(claudeMd)) {
    ensureSymlink(agentsMd, claudeMd);
}

// 5. Ensure default heartbeat.json if missing
const heartbeatPath = path.join(clawHome, 'heartbeat.json');
if (!fs.existsSync(heartbeatPath)) {
    fs.writeFileSync(heartbeatPath, JSON.stringify({ jobs: [] }, null, 2));
    console.log(`[claw:init] created ${heartbeatPath}`);
}

console.log('[claw:init] setup complete ✅');
