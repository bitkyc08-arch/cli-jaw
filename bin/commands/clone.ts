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
import { normalizeSkillNamespace } from '../../lib/mcp/skills-migration.js';
import { resolveHomePath } from '../../src/core/path-expand.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw clone — clone instance as independent agent

  Usage: jaw clone <port> [--home <path>] [--link-skills]

  Creates a new jaw instance with its own data directory.
  Copies config + skills, creates fresh DB.

  Options:
    --home <path>     Target directory (default: ~/.cli-jaw-<port>)
    --link-skills     Symlink skills from source instead of copying
`);

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
    ? resolveHomePath(positionals[0], os.homedir())
    : null;

if (!target) {
    console.error('Usage: jaw clone <target-dir> [--from <source>] [--with-memory] [--link-ref]');
    process.exit(1);
}

const source = values.from
    ? resolveHomePath(values.from as string, os.homedir())
    : JAW_HOME;
const withMemory = values['with-memory'] as boolean;
const linkRef = values['link-ref'] as boolean;

if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    console.error(`❌ Target directory not empty: ${target}`);
    process.exit(1);
}

if (!fs.existsSync(source)) {
    console.error(`❌ Source directory does not exist: ${source}`);
    process.exit(1);
}
if (!fs.existsSync(path.join(source, 'settings.json'))) {
    console.error(`❌ Source is not a valid cli-jaw instance (missing settings.json): ${source}`);
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

// ── 5b. Normalize the clone onto jaw-* ids ──
// The source may be a pre-rename home, and steps 4/5 copy it verbatim. Without
// this the clone starts life holding legacy directories that nothing else will
// ever visit. A symlinked skills_ref is skipped inside the migration itself:
// that tree belongs to the source home and is migrated there.
try {
    const result = normalizeSkillNamespace(path.join(target, 'skills'), target);
    const moved = result.renamed.length + result.backedUp.length;
    if (moved > 0) console.log(`  ↻ migrated ${moved} legacy skill id(s) to jaw-*`);
} catch (e) {
    console.warn(`  ⚠ skill namespace migration skipped: ${(e as Error).message}`);
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
        if (entry.isSymbolicLink()) {
            // Legacy-name compatibility links. copyFileSync on a directory
            // symlink is ENOTSUP, and following it would resurrect the legacy
            // name as a real duplicate skill. Recreate the link instead.
            try {
                const target = fs.readlinkSync(srcPath);
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                fs.symlinkSync(target, destPath, 'junction');
            } catch { /* a clone without the link still has the canonical skill */ }
        } else if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
