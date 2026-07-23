// Programmatic node:test runner.
//
// Why: `tsx --test` (tsx 4.21 + node 24.x) triggers "node:test run() called
// recursively" and produces ZERO output (even a trivial zero-import test). A
// programmatic node:test run() from plain tsx (no --test flag) avoids that.
//
//   tsx --experimental-test-module-mocks tests/run.mts [--all|--watch|<paths...>]
// --experimental-test-module-mocks must stay a node flag so mock.module works.
//
// isolation:'process' runs each file in its own subprocess (matching the old
// `--test` default). This keeps real-process/timing tests (bgtask spawn, session
// probes) from contending in one shared event loop — in-process concurrency made
// them flaky. CLI_JAW_HOME (set by setup/test-home.ts here) is inherited by the
// child processes via env; --experimental-test-module-mocks propagates too.
import './setup/test-home.ts';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
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
let passes = 0;
let runtimeSkips = 0;
const startedAt = Date.now();
const e2eDir = join(TESTS_DIR, 'e2e');
const writesE2eReceipt = !watch && explicit.length > 0 && files.every(file => resolve(file).startsWith(`${e2eDir}/`));
const stream = run({ files, concurrency: true, watch, isolation: 'process' });
stream.on('test:pass', event => {
    passes += 1;
    if ((event as { directive?: { type?: string } }).directive?.type === 'skip') runtimeSkips += 1;
});
stream.on('test:fail', () => { failures += 1; });
stream.compose(spec).pipe(process.stdout);
if (!watch) process.on('beforeExit', () => {
    if (writesE2eReceipt) {
        const sourceSkips = files.reduce((count, file) => {
            const source = readFileSync(file, 'utf8');
            return count + (source.match(/(?:\bt|\btest)\.skip\s*\(/g)?.length ?? 0);
        }, 0);
        const skipCount = runtimeSkips + sourceSkips;
        const receipt = {
            schemaVersion: 1,
            suite: 'dashboard2-e2e',
            discoveredFiles: files.map(file => file.slice(TESTS_DIR.length + 1)),
            passCount: passes,
            failCount: failures,
            skipCount,
            assertions: { skipCountEqualsZero: skipCount === 0 },
            rcSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(TESTS_DIR, '..'), encoding: 'utf8' }).trim(),
            durationMs: Date.now() - startedAt,
        };
        writeFileSync(resolve(TESTS_DIR, '..', 'refs', '094-e2e-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
        if (skipCount > 0) failures += 1;
    }
    if (failures > 0 && !process.exitCode) process.exitCode = 1;
});
