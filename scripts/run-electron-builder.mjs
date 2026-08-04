#!/usr/bin/env node
/**
 * Run electron-builder with a node-gyp-capable python resolved first.
 *
 * The scripts used to inline the lookup as
 * `PYTHON="$(bash ../scripts/pick-gyp-python.sh)" electron-builder --win`.
 * npm hands package scripts to cmd.exe on Windows, which does not expand
 * `$(...)`, so the literal text arrived as a filename and the Windows job of
 * every desktop release from v2.2.11 onward died before electron-builder even
 * started:
 *
 *   PYTHON: can't open file 'D:\a\cli-jaw\cli-jaw\electron\=$(bash ..\scripts\pick-gyp-python.sh)'
 *
 * macOS and Linux kept building, so the release looked successful while its
 * Windows artifacts silently went missing.
 *
 * Node is the one interpreter guaranteed to exist wherever npm runs a script,
 * so the resolution happens here instead of in shell syntax. The picker itself
 * stays in bash and stays authoritative; it is simply invoked rather than
 * interpolated. When bash is unavailable (a plain Windows box without Git
 * Bash), the build proceeds with the ambient python3: node-gyp then fails with
 * its own diagnostic instead of a confusing missing-file error.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const picker = join(scriptsDir, 'pick-gyp-python.sh');

/** Ask the bash picker for an interpreter that still has distutils. */
function resolvePython() {
    if (process.env['PYTHON']) return process.env['PYTHON'];
    const probe = spawnSync('bash', [picker], { encoding: 'utf8' });
    if (probe.status !== 0) {
        const reason = probe.error ? probe.error.message : (probe.stderr || '').trim();
        console.warn(`[gyp-python] picker unavailable (${reason || 'unknown'}); leaving python resolution to node-gyp`);
        return null;
    }
    return probe.stdout.trim() || null;
}

const python = resolvePython();
const env = { ...process.env };
if (python) {
    env['PYTHON'] = python;
    // node-gyp does not read PYTHON on its own; npm_config_python is the knob
    // it actually consults.
    env['npm_config_python'] = python;
}

const args = process.argv.slice(2);
const builder = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder';
const result = spawnSync(builder, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });

if (result.error) {
    console.error(`[electron-builder] failed to start: ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
