#!/usr/bin/env node
/**
 * Fail when the sidecar prune list would delete something the server imports.
 *
 * `scripts/bundle-sidecar.sh` ships a hand-written list of "frontend-only"
 * packages and `rm -rf`s them out of the bundled sidecar. The list was wrong
 * from the commit that introduced it: `node-fetch` sat in it while
 * `src/telegram/bot.ts` imports it, so any packaged desktop app died the
 * moment that module loaded --
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find package 'node-fetch'
 *   imported from .../Resources/server/dist/src/telegram/bot.js
 *
 * The dependency graph cannot answer this on its own: frontend and server
 * packages both live in `dependencies`, so "reachable from package.json" marks
 * 34 of the 37 pruned entries as unsafe and tells you nothing. What actually
 * separates them is whether SERVER source imports the package -- so that is
 * what this checks, and it also follows each kept package's own dependencies,
 * because deleting a transitive one breaks the import just as thoroughly.
 * `web-streams-polyfill` is exactly that case: nothing in src/ names it, but
 * node-fetch -> fetch-blob -> web-streams-polyfill, and it was on the list too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Trees whose imports must survive pruning.
 *
 * `dist` is what the sidecar actually runs, so it is the authority; the
 * TypeScript sources are scanned too because a fresh checkout may not have
 * built yet and a checker that silently passes on a missing directory is worse
 * than one that over-approximates.
 */
const SERVER_SOURCES = ['dist', 'src', 'bin', 'server.ts'];

/** Packages the prune step removes, read from the shell script itself. */
function prunedPackages() {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts/bundle-sidecar.sh'), 'utf8');

    const listBlock = script.match(/PRUNE_PKGS=\(([\s\S]*?)\n\)/);
    if (!listBlock) throw new Error('PRUNE_PKGS array not found in bundle-sidecar.sh');
    const listed = [...listBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    // The script also removes a handful of packages with individual rm -rf
    // lines below the loop. Those are just as capable of breaking the sidecar,
    // so they are checked with the same rule rather than trusted.
    const individual = [...script.matchAll(
        /rm -rf "\$SIDECAR_DIR\/node_modules\/([^"$]+)"/g)].map((m) => m[1]);

    return [...new Set([...listed, ...individual])];
}

/** Every file under the server source trees. */
function serverFiles() {
    const files = [];
    const walk = (rel) => {
        const abs = path.join(repoRoot, rel);
        if (!fs.existsSync(abs)) return;
        if (fs.statSync(abs).isFile()) { files.push(abs); return; }
        for (const entry of fs.readdirSync(abs)) {
            if (entry === 'node_modules' || entry.startsWith('.')) continue;
            walk(path.join(rel, entry));
        }
    };
    SERVER_SOURCES.forEach(walk);
    return files.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f));
}

/** Bare package specifiers imported anywhere in the server sources. */
function serverImports() {
    const found = new Set();
    const patterns = [
        /\bfrom\s+['"]([^'".][^'"]*)['"]/g,
        /\brequire\(\s*['"]([^'".][^'"]*)['"]\s*\)/g,
        /\bimport\(\s*['"]([^'".][^'"]*)['"]\s*\)/g,
    ];
    for (const file of serverFiles()) {
        const text = fs.readFileSync(file, 'utf8');
        for (const re of patterns) {
            for (const m of text.matchAll(re)) {
                const spec = m[1];
                if (spec.startsWith('node:')) continue;
                // Scoped names keep two segments, plain names keep one.
                const name = spec.startsWith('@')
                    ? spec.split('/').slice(0, 2).join('/')
                    : spec.split('/')[0];
                found.add(name);
            }
        }
    }
    return found;
}

/** Everything reachable from `roots` through installed package dependencies. */
function closure(roots) {
    const seen = new Set();
    const stack = [...roots];
    while (stack.length > 0) {
        const name = stack.pop();
        if (seen.has(name)) continue;
        seen.add(name);
        const manifest = path.join(repoRoot, 'node_modules', name, 'package.json');
        if (!fs.existsSync(manifest)) continue;
        let manifestJson;
        try {
            manifestJson = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        } catch { continue; }
        // Follow optional and peer edges too. A package that resolves one of
        // them at runtime fails identically to a missing hard dependency, and
        // over-keeping costs disk while under-keeping ships a broken app.
        const deps = {
            ...(manifestJson.dependencies || {}),
            ...(manifestJson.optionalDependencies || {}),
            ...(manifestJson.peerDependencies || {}),
        };
        for (const dep of Object.keys(deps)) if (!seen.has(dep)) stack.push(dep);
    }
    return seen;
}

export function findUnsafePrunes() {
    const pruned = prunedPackages();
    const imported = serverImports();
    // Only walk from packages the server actually imports; the closure of every
    // dependency would sweep the frontend back in.
    const required = closure([...imported]);

    return pruned
        .filter((pkg) => required.has(pkg))
        .map((pkg) => ({
            pkg,
            direct: imported.has(pkg),
        }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const unsafe = findUnsafePrunes();
    if (unsafe.length === 0) {
        console.log('✅ sidecar prune list removes nothing the server needs');
        process.exit(0);
    }
    console.error(`❌ sidecar prune list — ${unsafe.length} package(s) the server needs:`);
    for (const { pkg, direct } of unsafe) {
        console.error(`   ${pkg} — ${direct
            ? 'imported directly by server source'
            : 'required transitively by a package the server imports'}`);
    }
    console.error('\nRemove them from scripts/bundle-sidecar.sh, or the packaged app will');
    console.error('die with ERR_MODULE_NOT_FOUND the first time that code path runs.');
    process.exit(1);
}
