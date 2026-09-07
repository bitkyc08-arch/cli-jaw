#!/usr/bin/env node
// Validates scripts/ci/windows-unit-manifest.txt — the list of unit test files
// the windows-unit job runs on windows-latest. One repo-relative POSIX path per
// line; blank lines and full-line '#' comments are ignored; no globs, duplicates,
// traversal, or paths outside tests/unit/. Consumed by the Windows job (--print)
// and by tests/unit/windows-unit-manifest.test.ts, so a renamed test breaks on
// Linux before it silently vanishes from the Windows lane.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const MANIFEST_PATH = 'scripts/ci/windows-unit-manifest.txt';
const ENTRY = /^tests\/unit\/[A-Za-z0-9_-]+\.test\.ts$/;

/** @returns {string[]} validated entries in manifest order; throws with the reason */
export function readManifest(manifestPath, { root } = {}) {
    const repoRoot = root ?? resolve(fileURLToPath(import.meta.url), '..', '..', '..');
    const abs = resolve(repoRoot, manifestPath);
    if (!existsSync(abs)) throw new Error(`manifest missing: ${manifestPath}`);
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    const entries = [];
    const seen = new Set();
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        const where = `${manifestPath}:${i + 1}`;
        if (!ENTRY.test(line)) throw new Error(`${where}: invalid entry '${line}' (expected tests/unit/<name>.test.ts)`);
        if (seen.has(line)) throw new Error(`${where}: duplicate entry '${line}'`);
        const file = join(repoRoot, line);
        if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${where}: missing file '${line}'`);
        seen.add(line);
        entries.push(line);
    });
    if (entries.length === 0) throw new Error(`${manifestPath}: empty manifest`);
    return entries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const print = args.includes('--print');
    const target = args.find(a => !a.startsWith('--')) ?? MANIFEST_PATH;
    try {
        const entries = readManifest(target);
        if (print) process.stdout.write(entries.join('\n') + '\n');
        else console.log(`windows-unit manifest ok: ${entries.length} files`);
    } catch (error) {
        console.error(`[windows-unit-manifest] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

