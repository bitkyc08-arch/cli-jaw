#!/usr/bin/env node
// Does the packaged sidecar still have everything the server imports?
//
// bundle-sidecar.sh prunes frontend-only packages to keep the app small, and
// twice now that list has taken something the server needs. First `node-fetch`
// itself, which killed every instance touching the Telegram path. Then, after
// that was fixed, `web-streams-polyfill` — which is not frontend-only either:
// node-fetch depends on fetch-blob, and fetch-blob declares it.
//
// Be precise about that second one, because the first version of this comment
// was not. fetch-blob only reaches for the polyfill when `globalThis.ReadableStream`
// is absent, and on the bundled Node 24 it is present, so the missing package
// does not currently throw. It is still a package the server's dependency tree
// asks for and the bundle does not have, which is a loaded gun: any Node
// downgrade, any other consumer of that polyfill, and it fires. The point of
// this check is to catch that shape before it becomes a crash rather than
// after.
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
import { createRequire, isBuiltin } from 'node:module';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

// realpath matters: macOS resolves /var/folders to /private/var/folders, and
// without this the resolved package paths never startsWith(dir) — every kept
// package read as "pruned", so its dependencies were never walked and the
// guard passed with the very hole it exists to catch (sidecar-prune-safety).
const dir = realpathSync(resolve(process.argv[2] ?? '.'));
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
 * Hermetic resolution: a package counts as present ONLY if it resolves under
 * the sidecar itself. createRequire walks up to a parent node_modules, which
 * is how a pruned package (mermaid) reads as present and its own pruned
 * dependencies read as missing — a false alarm that hides the real signal.
 */
function resolvesInside(name, fromRequire) {
    try {
        // Trust the resolver first: it handles npm's nesting (picomatch lives
        // inside micromatch, not at the top level) and only accepts a path
        // under the sidecar.
        const resolved = fromRequire.resolve(name);
        return resolved.startsWith(dir);
    } catch {
        // require.resolve throws for ESM-only packages (dunder-proto has no
        // CJS exports main). Presence under the sidecar is the fallback: top
        // level, or nested anywhere in the tree.
        if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
        return findNested(join(dir, 'node_modules'), name, 0);
    }
}

/** npm nests a dependency inside its parent on version conflict. */
function findNested(nodeModules, name, depth) {
    if (depth > 4 || !existsSync(nodeModules)) return false;
    for (const entry of readdirSyncSafe(nodeModules)) {
        if (entry === name && existsSync(join(nodeModules, entry, 'package.json'))) return true;
        const sub = join(nodeModules, entry, 'node_modules');
        if (findNested(sub, name, depth + 1)) return true;
    }
    return false;
}

function readdirSyncSafe(dir) {
    try { return readdirSync(dir); } catch { return []; }
}

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
    // Node builtins (buffer, string_decoder) appear in dependency lists but
    // are not npm packages to bundle.
    if (isBuiltin(name)) return;
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
        // package.json resolved, but it may have come from a parent
        // node_modules outside the sidecar. Confirm it is really bundled.
        if (!resolvesInside(name, from)) {
            if (prunedRoots.has(name)) return;
            if (name.startsWith('@types/')) return;
            missing.push({ name, chain: [...chain, name].join(' -> ') });
            return;
        }
    } catch {
        // Some packages hide package.json behind `exports`. Resolving the
        // package itself still proves it is present — but presence is not the
        // end: its own dependencies still need checking.
        try {
            if (!resolvesInside(name, from)) throw new Error('outside sidecar');
            // Read the bundled package.json directly so the walk continues
            // into this package's own dependencies instead of stopping here.
            const pkgJsonPath = join(dir, 'node_modules', name, 'package.json');
            meta = existsSync(pkgJsonPath) ? JSON.parse(readFileSync(pkgJsonPath, 'utf8')) : null;
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
// Hermetic: a package is pruned if it does NOT resolve under the sidecar.
// The old logic used bare require.resolve, which finds pruned packages in a
// parent node_modules and reports them as present — defeating the whole check.
const prunedRoots = new Set(declared.filter((name) => {
    return !resolvesInside(name, require);
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
