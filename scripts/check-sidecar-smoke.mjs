#!/usr/bin/env node
/**
 * Post-bundle import smoke for the packaged sidecar (260803 unit, 040 phase D3).
 *
 * `check-sidecar-prune-safety.mjs` reasons about the prune list statically: it
 * parses PRUNE_PKGS out of the shell script, scans source for bare specifiers,
 * and walks the transitive closure through dependencies/optionalDependencies/
 * peerDependencies. That closure is what catches the second half of the v2.2.10
 * incident (`node-fetch → fetch-blob → web-streams-polyfill`).
 *
 * What it cannot see is a computed specifier — `import(someVariable)`. The
 * authors knew, which is why RUNTIME_LOADED exists as a manual escape hatch
 * with exactly one entry. Any future dynamic import that nobody remembers to
 * register reproduces the incident in a new shape.
 *
 * This closes that by construction: after the bundle exists, actually import
 * the modules whose failure was invisible last time. A dashboard returning 200
 * never proved the Telegram bot could load; importing it does.
 *
 * Usage: node scripts/check-sidecar-smoke.mjs [--server-root <dir>]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--server-root');
// An explicit --server-root means the caller built the bundle and knows where
// it should be (bundle-sidecar.sh passes it immediately after bundling), so a
// missing tree there is a real failure rather than "nothing to check".
const explicitServerRoot = rootIndex >= 0;
if (explicitServerRoot && !args[rootIndex + 1]) {
    console.error('❌ --server-root requires a directory argument');
    process.exit(2);
}
const serverRoot = resolve(explicitServerRoot ? args[rootIndex + 1] : 'electron/sidecar/server');

/**
 * Entry surfaces whose load failure would be silent in a running app: each is
 * reached only on a specific user action, so a healthy dashboard says nothing
 * about them. `telegram/bot.js` is the exact module the v2.2.10 prune broke.
 */
const CRITICAL_MODULES = [
    'dist/src/telegram/bot.js',
    'dist/server.js',
    'dist/src/manager/server.js',
];

/**
 * Exit code 3 = "nothing to check". The caller must NOT report this as a pass:
 * a gate that says "imports verified" when it imported nothing is the same
 * dishonest-green this script exists to eliminate.
 */
const EXIT_SKIPPED = 3;

if (!existsSync(serverRoot)) {
    // Keying this on CI made the gate demand a bundle that the node-tests
    // workflow never builds, so every PR failed here. Require a real check
    // only where the caller actually produced (or explicitly named) the tree.
    if (explicitServerRoot || process.env['JAW_GATE_REQUIRE_SIDECAR'] === '1') {
        console.error(`❌ sidecar not bundled at ${serverRoot} but the caller required a real smoke test`);
        process.exit(1);
    }
    console.log(`ℹ sidecar not bundled at ${serverRoot} — skipping smoke (run scripts/bundle-sidecar.sh first)`);
    process.exit(EXIT_SKIPPED);
}

const failures = [];
let checked = 0;
const seenCauses = new Set();

// Redirect the probe's home to a throwaway directory. Importing these modules
// regenerates AGENTS.md and touches the DB; a gate must not mutate the
// developer's real ~/.cli-jaw just by checking that the bundle loads.
const probeHome = mkdtempSync(join(tmpdir(), 'jaw-smoke-home-'));

for (const relative of CRITICAL_MODULES) {
    const target = join(serverRoot, relative);
    if (!existsSync(target)) {
        failures.push(`${relative}: not present in the bundle`);
        continue;
    }
    checked += 1;
    // Import in a CHILD process, never in-process. These modules are not inert:
    // dist/server.js binds ports, opens the DB, starts timers and writes user
    // state. Importing them here would hang the build forever and mutate the
    // developer's ~/.cli-jaw. We only need to know that resolution + top-level
    // evaluation get far enough to not throw, so a bounded child that we kill
    // is both sufficient and safe.
    const child = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(target).href)}); process.exit(0);`],
        {
            encoding: 'utf8',
            timeout: 30_000,
            killSignal: 'SIGKILL',
            env: {
                ...process.env,
                JAW_SMOKE_PROBE: '1',
                CLI_JAW_HOME: probeHome,
                // Keep the probe off any port the developer or CI is using.
                PORT: '0',
                DASHBOARD_PORT: '0',
            },
        },
    );

    // A module that boots a server never exits on its own; the timeout kill is
    // the SUCCESS signal there, because it means the import itself resolved.
    const timedOut = child.error && child.error.code === 'ETIMEDOUT';
    const importFailed = !timedOut
        && child.status !== 0
        && /ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|Cannot find package|Cannot find module/.test(child.stderr || '');

    if (importFailed) {
        // Prefer the human-readable "Cannot find package 'x'" line over the
        // internal `throw new ERR_MODULE_NOT_FOUND(...)` frame, which names no
        // package and is useless in a build log.
        const stderrLines = (child.stderr || '').split('\n');
        const line = stderrLines.find(l => /Cannot find (package|module)/.test(l))
            || stderrLines.find(l => /ERR_[A-Z_]+/.test(l))
            || `exit ${child.status}`;
        const cause = line.trim();
        if (!seenCauses.has(cause)) {
            seenCauses.add(cause);
            failures.push(`${relative}: ${cause}`);
        } else {
            failures.push(`${relative}: (same cause as above)`);
        }
        continue;
    }
    console.log(`   loaded: ${relative}${timedOut ? ' (kept running — import resolved)' : ''}`);
}

try {
    rmSync(probeHome, { recursive: true, force: true });
} catch {
    // best effort
}

if (failures.length > 0) {
    console.error('❌ sidecar smoke failed — the bundle is missing something it needs at runtime:');
    for (const line of failures) console.error(`   - ${line}`);
    console.error('\nThis is the v2.2.10 class: the app would start and look healthy, then fail');
    console.error('on first use of the affected surface. Check the prune list in scripts/bundle-sidecar.sh.');
    process.exit(1);
}

console.log(`✅ sidecar smoke ok (${checked} critical modules imported from ${serverRoot})`);
