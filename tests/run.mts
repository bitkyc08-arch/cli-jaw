// Programmatic node:test runner.
//
// Why: `tsx --test` (tsx 4.21 + node 24.x) triggers "node:test run() called
// recursively" and produces ZERO output (even a trivial zero-import test). A
// programmatic node:test run() from plain tsx (no --test flag) avoids that.
//
//   tsx --experimental-test-module-mocks tests/run.mts [--all|--watch|<paths...>]
// --experimental-test-module-mocks must stay a node flag so mock.module works.
import './setup/test-home.ts';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const TESTS_DIR = resolve(import.meta.dirname);
function list(dir: string, recursive: boolean): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (recursive) out.push(...list(full, true)); }
        else if (e.name.endsWith('.test.ts')) out.push(full);
    }
    return out.sort();
}
const argv = process.argv.slice(2);
const all = argv.includes('--all');
const watch = argv.includes('--watch');
const explicit = argv.filter(a => !a.startsWith('--'));
let files: string[];
if (explicit.length > 0) files = explicit.flatMap(p => { const a = resolve(p); return (existsSync(a) && statSync(a).isDirectory()) ? list(a, true) : [a]; });
else if (all) files = list(TESTS_DIR, true);
else files = [...list(TESTS_DIR, false), ...list(join(TESTS_DIR, 'unit'), false)];
if (files.length === 0) { console.error('[tests/run] no test files matched'); process.exit(1); }
let failures = 0;
run({ files, concurrency: true, watch }).on('test:fail', () => { failures += 1; }).compose(spec).pipe(process.stdout);
if (!watch) process.on('beforeExit', () => { if (failures > 0 && !process.exitCode) process.exitCode = 1; });
