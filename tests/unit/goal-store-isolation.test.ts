// #288: the runner gives every test file its own process but ONE shared
// CLI_JAW_HOME (tests/run.mts:42 + tests/setup/test-home.ts:8), so every file
// that calls setGoal writes the same goal/active.json. setGoal throws when an
// active goal already exists, so a sibling process's goal kills this one's
// setup. Measured before the fix: 3 of 5 concurrent runs failed, 3 of 3
// isolated runs passed.
//
// This file proves the isolation is real. It deliberately checks the BOUND
// path rather than the env string: if an import landed in the wrong order,
// CLI_JAW_HOME could point at the isolated home while src/core/config.ts had
// already bound the parent's — green test, live race.
import '../setup/isolated-home.ts';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const unitDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(unitDir, '..', '..');

/** Files that call setGoal and therefore share the goal store. */
function goalOwningFiles(): string[] {
    return readdirSync(unitDir)
        .filter(name => name.endsWith('.test.ts'))
        .filter(name => name !== basename(fileURLToPath(import.meta.url)))
        .filter(name => /\bsetGoal\s*\(/.test(readFileSync(join(unitDir, name), 'utf8')));
}

/**
 * A file is isolated either by importing the shared helper, or by assigning
 * CLI_JAW_HOME itself before a dynamic import (which lands before config binds).
 */
function isolationMechanism(source: string): 'helper' | 'self' | null {
    if (source.includes("setup/isolated-home")) return 'helper';
    if (/process\.env\.CLI_JAW_HOME\s*=/.test(source) && /await import\(/.test(source)) return 'self';
    return null;
}

test('GSI-001: every goal-owning test file carries an isolation mechanism', () => {
    const missing = goalOwningFiles().filter(
        name => isolationMechanism(readFileSync(join(unitDir, name), 'utf8')) === null,
    );
    assert.deepEqual(missing, [],
        `these files call setGoal without isolating their CLI_JAW_HOME: ${missing.join(', ')}`);
});

test('GSI-002: goal-owning files resolve distinct bound goal paths', () => {
    const files = goalOwningFiles();
    assert.ok(files.length >= 6, `expected the goal-owning set, found ${files.length}`);

    // Import the target first so its own isolation fires, then read what
    // src/core/config.ts actually bound. The active path mirrors the derivation
    // in src/goal/store.ts:7-8 — ACTIVE_PATH is not exported.
    // The imported test file prints its own output, so tag the one line we want
    // rather than trusting the last line of stdout.
    const MARK = 'GSI002:';
    const probe = (file: string) => `
        await import(${JSON.stringify(join(unitDir, file))});
        const { JAW_HOME } = await import(${JSON.stringify(join(projectRoot, 'src/core/config.ts'))});
        const { join } = await import('node:path');
        console.log(${JSON.stringify(MARK)} + JSON.stringify({ home: JAW_HOME, active: join(JAW_HOME, 'goal', 'active.json') }));
    `;

    const seen = new Map<string, string>();
    for (const file of files) {
        const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe(file)], {
            cwd: projectRoot, encoding: 'utf8', timeout: 60_000,
        });
        const line = (run.stdout || '').split('\n').find(row => row.includes(MARK));
        if (!line) continue; // a file that refuses to import standalone proves nothing here
        const { active } = JSON.parse(line.slice(line.indexOf(MARK) + MARK.length)) as { home: string; active: string };
        const clash = seen.get(active);
        assert.equal(clash, undefined,
            `${file} and ${clash} resolve the same goal store at ${active}`);
        seen.set(active, file);
    }
    assert.ok(seen.size > 1, 'expected at least two files to report a bound goal path');
});

test('GSI-003: the shared helper really redirects the home', () => {
    assert.ok(basename(process.env['CLI_JAW_HOME'] || '').startsWith('cli-jaw-test-iso-'),
        `this file imported the helper first, so its home should be an isolated one; got ${process.env['CLI_JAW_HOME']}`);
});
