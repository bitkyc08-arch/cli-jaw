// Programmatic node:test runner.
//
// Why this exists: `tsx --test` (tsx 4.21.0 + node 24.x) triggers
// "node:test run() is being called recursively within a test file. skipping
// running files." and produces ZERO output — the tsx loader collides with
// node's `--test` runner main. Driving node:test's programmatic `run()` from a
// plain `tsx` process (no `--test` flag) avoids that entirely.
//
// Usage:
//   tsx --experimental-test-module-mocks tests/run.mts            # tests/*.test.ts + tests/unit/*.test.ts
//   tsx --experimental-test-module-mocks tests/run.mts --all      # + every tests/**/*.test.ts (incl. integration)
//   tsx --experimental-test-module-mocks tests/run.mts --watch    # watch mode
//   tsx --experimental-test-module-mocks tests/run.mts <path ...> # explicit files/dirs
//
// `--experimental-test-module-mocks` must stay a node flag so mock.module works.

import './setup/test-home.ts'; // sets CLI_JAW_HOME before any test module loads
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const TESTS_DIR = resolve(import.meta.dirname);

function listTestFiles(dir: string, recursive: boolean): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (recursive) out.push(...listTestFiles(full, true));
        } else if (entry.name.endsWith('.test.ts')) {
            out.push(full);
        }
    }
    return out.sort();
}

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const watch = argv.includes('--watch');
const explicit = argv.filter(a => !a.startsWith('--'));

let files: string[];
if (explicit.length > 0) {
    files = explicit.flatMap(p => {
        const abs = resolve(p);
        if (existsSync(abs) && statSync(abs).isDirectory()) return listTestFiles(abs, true);
        return [abs];
    });
} else if (all) {
    files = listTestFiles(TESTS_DIR, true);
} else {
    files = [
        ...listTestFiles(TESTS_DIR, false),
        ...listTestFiles(join(TESTS_DIR, 'unit'), false),
    ];
}

if (files.length === 0) {
    console.error('[tests/run] no test files matched');
    process.exit(1);
}

let failures = 0;
run({ files, concurrency: true, watch })
    .on('test:fail', () => { failures += 1; })
    .compose(spec)
    .pipe(process.stdout);

// node:test resolves the run stream on completion; the pipe keeps the event
// loop alive until then. Set a non-zero exit code if anything failed.
// (watch mode never exits, so the exit code is irrelevant there.)
if (!watch) {
    process.on('beforeExit', () => {
        if (failures > 0 && !process.exitCode) process.exitCode = 1;
    });
}
