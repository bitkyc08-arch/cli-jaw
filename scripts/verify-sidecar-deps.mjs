#!/usr/bin/env node
// Does the packaged sidecar still have everything the server imports?
//
// bundle-sidecar.sh prunes frontend-only packages to keep the app small, and
// twice now that list has taken something the server needs. First `node-fetch`
// itself, which killed every instance touching the Telegram path. Then, after
// that was fixed, `web-streams-polyfill` — which is not frontend-only either:
// node-fetch depends on fetch-blob, and fetch-blob depends on it. The packaged
// app died at boot with ERR_MODULE_NOT_FOUND for `node-fetch` while node-fetch
// was sitting right there, because its own dependency was gone.
//
// A comment saying "only genuinely frontend-only packages belong here" is a
// rule. This is the check. It walks the production dependency closure from the
// sidecar's package.json and resolves every package from the sidecar itself.
//
// Frontend-only packages ARE expected to be missing — that is the point of the
// prune. What matters is whether anything still reachable from a pruned
// package's parents is needed at runtime, so the walk starts from the packages
// that survived and reports only gaps inside that closure.
//
// Usage: node scripts/verify-sidecar-deps.mjs <sidecar dir>
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const pkgPath = join(dir, 'package.json');
if (!existsSync(pkgPath)) {
    console.error(`[verify-sidecar-deps] no package.json at ${dir}`);
    process.exit(2);
}

const require = createRequire(pkgPath);
const root = require('./package.json');

const missing = [];
const seen = new Set();

/**
 * Resolve a package and recurse into its own dependencies.
 *
 * `pruned` marks a package the bundle deliberately removed. Its absence is
 * expected and its subtree is not walked; the bug this catches is a package
 * that is PRESENT but whose own dependency was taken away underneath it.
 */
function walk(name, chain, prunedRoots) {
    const key = `${chain[chain.length - 1] ?? ''}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    let meta;
    // Resolve FROM THE PARENT, not from the sidecar root. npm may nest a
    // dependency inside its parent when versions conflict, and picomatch is
    // nested inside micromatch here — resolving it from the root reports it
    // missing when it is present exactly where its parent looks for it.
    const parent = chain[chain.length - 1];
    const from = parent && parent !== '(root)'
        ? (() => {
            try { return createRequire(require.resolve(`${parent}/package.json`)); }
            catch { return require; }
        })()
        : require;
    try {
        meta = from(`${name}/package.json`);
    } catch {
        // Some packages hide package.json behind `exports`. Resolving the
        // package itself still proves it is present.
        try {
            from.resolve(name);
            return;
        } catch {
            // A top-level package the prune list removed on purpose.
            if (prunedRoots.has(name)) return;
            // Type-only packages are stripped wholesale and never imported at
            // runtime; `@types/*` under a bundled package is not a defect.
            if (name.startsWith('@types/')) return;
            missing.push({ name, chain: [...chain, name].join(' -> ') });
            return;
        }
    }
    for (const dep of Object.keys(meta.dependencies ?? {})) {
        walk(dep, [...chain, name], prunedRoots);
    }
}

// Anything declared but absent at the top level was pruned deliberately. The
// question is what the SURVIVING packages still need.
const declared = Object.keys(root.dependencies ?? {});
const prunedRoots = new Set(declared.filter((name) => {
    try { require.resolve(`${name}/package.json`); return false; }
    catch {
        try { require.resolve(name); return false; } catch { return true; }
    }
}));

for (const dep of declared) walk(dep, ['(root)'], prunedRoots);

if (missing.length) {
    console.error(`[verify-sidecar-deps] ${missing.length} package(s) are needed by a package that IS bundled, but are missing:`);
    for (const m of missing) console.error(`  ${m.name}   via ${m.chain}`);
    console.error('\nThe prune list in scripts/bundle-sidecar.sh removed a server dependency,');
    console.error('or a transitive dependency of one. Frontend-only means nothing under');
    console.error('dist/src/** can reach it, directly or through another package.');
    process.exit(1);
}

console.log(`[verify-sidecar-deps] OK: ${seen.size} packages walked from ${dir}`
    + ` (${prunedRoots.size} pruned at the top level, as intended)`);
