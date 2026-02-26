/**
 * cli-jaw clone — Create independent agent instance
 * Copies config + skills, creates fresh DB, regenerates AGENTS.md
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JAW_HOME } from '../../src/core/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
        from:          { type: 'string' },
        'with-memory': { type: 'boolean', default: false },
        'link-ref':    { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
});

const target = positionals[0]
    ? path.resolve(positionals[0].replace(/^~(?=\/|$)/, os.homedir()))
    : null;

if (!target) {
    console.error('Usage: jaw clone <target-dir> [--from <source>] [--with-memory] [--link-ref]');
    process.exit(1);
}

const source = values.from
    ? path.resolve((values.from as string).replace(/^~(?=\/|$)/, os.homedir()))
    : JAW_HOME;
const withMemory = values['with-memory'] as boolean;
const linkRef = values['link-ref'] as boolean;

if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    console.error(`❌ Target directory not empty: ${target}`);
    process.exit(1);
}

// ── 1. Create target structure ──
fs.mkdirSync(target, { recursive: true });
for (const dir of ['prompts', 'skills', 'worklogs', 'uploads', 'memory', 'logs']) {
    fs.mkdirSync(path.join(target, dir), { recursive: true });
}

// ── 2. Copy config files ──
for (const file of ['settings.json', 'mcp.json', 'heartbeat.json']) {
    const src = path.join(source, file);
    if (fs.existsSync(src)) {
        if (file === 'settings.json') {
            const settings = JSON.parse(fs.readFileSync(src, 'utf8'));
            settings.workingDir = target;
            fs.writeFileSync(path.join(target, file), JSON.stringify(settings, null, 4));
        } else {
            fs.copyFileSync(src, path.join(target, file));
        }
    }
}

// ── 3. Copy prompts (A-1, A-2 — user personality; skip B.md — regenerated) ──
const promptsSrc = path.join(source, 'prompts');
if (fs.existsSync(promptsSrc)) {
    for (const file of fs.readdirSync(promptsSrc)) {
        if (file === 'B.md') continue;
        const srcFile = path.join(promptsSrc, file);
        if (fs.statSync(srcFile).isFile()) {
            fs.copyFileSync(srcFile, path.join(target, 'prompts', file));
        }
    }
}

// ── 4. Copy skills ──
copyDirRecursive(path.join(source, 'skills'), path.join(target, 'skills'));

// ── 5. skills_ref — copy or symlink ──
const skillsRefSrc = path.join(source, 'skills_ref');
if (fs.existsSync(skillsRefSrc)) {
    if (linkRef) {
        fs.symlinkSync(skillsRefSrc, path.join(target, 'skills_ref'));
    } else {
        copyDirRecursive(skillsRefSrc, path.join(target, 'skills_ref'));
    }
}

// ── 6. Optional memory ──
if (withMemory) {
    const memSrc = path.join(source, 'memory', 'MEMORY.md');
    if (fs.existsSync(memSrc)) {
        fs.copyFileSync(memSrc, path.join(target, 'memory', 'MEMORY.md'));
    }
}

// ── 7. jaw.db — NOT copied (fresh DB on first access) ──

// ── 8. Regenerate AGENTS.md + B.md via subprocess ──
// Must use subprocess: JAW_HOME is const at module load, re-import returns cached value.
const projectRoot = path.join(__dirname, '..', '..');
try {
    execSync(
        `node -e "` +
        `const { loadSettings } = await import('./src/core/config.js'); ` +
        `loadSettings(); ` +
        `const { regenerateB } = await import('./src/prompt/builder.js'); ` +
        `regenerateB();"`,
        {
            cwd: projectRoot,
            env: { ...process.env, CLI_JAW_HOME: target },
            stdio: 'pipe',
        }
    );
} catch {
    console.log('  ⚠️ AGENTS.md regeneration skipped (run jaw --home <target> init to fix)');
}

// ── 9. Summary ──
console.log(`
✅ Cloned to ${target}

  Copied:
    ✅ prompts/ (personality)
    ✅ skills/
    ${linkRef ? '🔗' : '✅'} skills_ref/${linkRef ? ' (symlinked)' : ''}
    ✅ config (settings.json, mcp.json, heartbeat.json)
    ${withMemory ? '✅' : '⏭️'} memory/MEMORY.md

  Fresh:
    🆕 jaw.db (created on first access)
    🆕 worklogs/
    🔄 AGENTS.md (regenerated)

  Launch:
    jaw serve --home ${target}
    jaw serve --home ${target} --port 3458
`);

// ── Helper: recursive directory copy ──
function copyDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
