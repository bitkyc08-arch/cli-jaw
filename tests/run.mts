// Programmatic node:test runner.
//
// Why: `tsx --test` (tsx 4.21 + node 24.x) triggers "node:test run() called
// recursively" and produces ZERO output (even a trivial zero-import test). A
// programmatic node:test run() from plain tsx (no --test flag) avoids that.
//
//   tsx --experimental-test-module-mocks tests/run.mts [--all|--scope root,unit|<paths...>] [--shard i/N] [--list] [--watch]
// --experimental-test-module-mocks must stay a node flag so mock.module works.
//
// Scopes: root (tests/*.test.ts), unit (tests/unit/*.test.ts) — both flat — and
// integration/manager/browser/bin (recursive under tests/<scope>/). Default is
// root,unit, which is what `npm test` has always meant. --shard i/N keeps the
// sorted-round-robin slice i of the selected files (see tests/setup/shard.ts);
// --list prints the selection and exits without running.
//
// isolation:'process' runs each file in its own subprocess (matching the old
// `--test` default). This keeps real-process/timing tests (bgtask spawn, session
// probes) from contending in one shared event loop — in-process concurrency made
// them flaky.
//
// Every child re-imports setup/test-home.ts through the run() execArgv option, so
// each FILE gets its own fresh CLI_JAW_HOME and jaw.db. Without that, children
// inherit the parent's single home and two files can race the same first-open
// migration (SqliteError: duplicate column name) — a failure that only shows up
// when enough DB-touching files land in one batch, i.e. exactly what sharding
// changes. The old CI invocation (--import test-home.ts --test) had per-file homes
// for the same reason; this keeps that behavior inside the driver.
//
// forceExit mirrors the --test-force-exit the CI invocation always carried: a
// file whose test left a handle open (a spawned child, a server) would otherwise
// keep its process alive after the last test and stall the whole shard — shard 3/4
// of run 34138235928 went silent for 4.5 minutes after ~half its files finished
// and was killed by the step timeout. Node rejects forceExit together with watch,
// so watch mode keeps the old behavior.
//
// Coverage: node:test only collects coverage when run() receives { coverage: true }
// (v22.10+); the --experimental-test-coverage flag alone is filtered out of the
// programmatic path, so it is bridged from execArgv here.
import './setup/test-home.ts';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { parseArgs, partitionFiles, type RunnerOptions } from './setup/shard.ts';

const TESTS_DIR = resolve(import.meta.dirname);
function list(dir: string, recursive: boolean): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (recursive) out.push(...list(full, true)); }
        else if (e.name.endsWith('.test.ts')) out.push(full);
    }
    return out;
}
function collectFiles({ explicit, all, scopes }: RunnerOptions): string[] {
    if (explicit.length) return explicit.flatMap(p => {
        const absolute = resolve(p);
        return existsSync(absolute) && statSync(absolute).isDirectory() ? list(absolute, true) : [absolute];
    });
    if (all) return list(TESTS_DIR, true);
    const selected = scopes.length ? scopes : ['root', 'unit'];
    return selected.flatMap(scope => list(
        scope === 'root' ? TESTS_DIR : join(TESTS_DIR, scope),
        scope !== 'root' && scope !== 'unit',
    ));
}
let options: RunnerOptions;
let files: string[];
try {
    options = parseArgs(process.argv.slice(2));
    files = partitionFiles(collectFiles(options).map(p => p.split(sep).join('/')), options.shard);
} catch (error) {
    console.error(`[tests/run] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
const { watch, list: listOnly } = options;
if (files.length === 0) { console.error('[tests/run] no test files matched'); process.exit(1); }
if (listOnly) { for (const f of files) console.log(f); process.exit(0); }
const scopeLabel = options.explicit.length ? 'explicit' : options.all ? 'all' : (options.scopes.length ? options.scopes : ['root', 'unit']).join(',');
console.log(`[tests/run] ${files.length} files (scope=${scopeLabel}, shard=${options.shard ? `${options.shard.index}/${options.shard.total}` : 'none'})`);
const coverage = process.execArgv.includes('--experimental-test-coverage');
const execArgv = ['--import', pathToFileURL(join(TESTS_DIR, 'setup', 'test-home.ts')).href];
let failures = 0;
run({ files, concurrency: true, watch, isolation: 'process', coverage, execArgv, forceExit: !watch }).on('test:fail', () => { failures += 1; }).compose(spec).pipe(process.stdout);
if (!watch) process.on('beforeExit', () => { if (failures > 0 && !process.exitCode) process.exitCode = 1; });
