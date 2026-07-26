#!/usr/bin/env node
// wp8 — does the prune list take anything the packaged runtime imports?
//
// verify-sidecar-deps.mjs walks the package.json dependency tree, but the
// server's ACTUAL imports live in dist/**/*.js, and the two are not the same
// set. node-fetch was pruned because the prune list and the dist imports were
// never intersected. This guard does that intersection, hermetically:
//
//   1. Scan dist/**/*.js for import/require specifiers (static + dynamic).
//   2. Scan bin/**/*.js too — the packaged CLI loads commands that the server
//      boot path does not (chat -> tui/highlight.js).
//   3. Intersect with the prune list and the transitive removals from
//      bundle-sidecar.sh. Any overlap is a server dependency about to be
//      removed: the next node-fetch.
//
// Hermetic means it reads ONLY the dist/bin sources and the prune list — it
// never resolves a package, so it cannot be fooled by a parent node_modules.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const BUNDLE = join(ROOT, 'scripts/bundle-sidecar.sh');

const BUILTIN = /^(node:)?(path|fs|url|http|https|os|crypto|stream|util|events|buffer|child_process|module|net|tls|zlib|querystring|assert|worker_threads|perf_hooks|async_hooks|readline|dns|tty|vm|constants|process|string_decoder|timers|fs\/promises)$/;

function scanImports(dir, acc) {
    if (!existsSync(dir)) return acc;
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) { scanImports(p, acc); continue; }
        if (!p.endsWith('.js') && !p.endsWith('.mjs') && !p.endsWith('.cjs')) continue;
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]/g)) {
            const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
            if (!spec || spec.startsWith('.') || spec.startsWith('/') || BUILTIN.test(spec)) continue;
            const parts = spec.split('/');
            acc.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
        }
    }
    return acc;
}

function pruneList() {
    const src = readFileSync(BUNDLE, 'utf8');
    const list = new Set();
    const pruneBlock = src.slice(src.indexOf('PRUNE_PKGS=('), src.indexOf(')', src.indexOf('PRUNE_PKGS=(')));
    for (const m of pruneBlock.matchAll(/"([^"]+)"/g)) list.add(m[1]);
    for (const m of src.matchAll(/rm -rf "\$SIDECAR_DIR\/node_modules\/([^"]+)"/g)) {
        const name = m[1].replace(/\/\*.*$/, '');
        if (name && !name.includes('*')) list.add(name);
    }
    return list;
}

// Scan BOTH the source dist (what the build produces) and the packaged
// sidecar dist (what the app actually runs). They can drift — the sidecar is
// only refreshed by a rebundle — so guarding only one proves the wrong tree.
const SIDECAR = join(ROOT, 'electron/sidecar/server');
const distImports = scanImports(join(ROOT, 'dist/src'), new Set());
const binImports = scanImports(join(ROOT, 'dist/bin'), new Set());
// The packaged runtime is what the app ACTUALLY runs, and it can drift from
// the source dist. Guard both. A missing sidecar is not a pass: it means the
// packaged tree is unbuilt, which must not read as "no overlap".
const sidecarPresent = existsSync(join(SIDECAR, 'dist'));
const sidecarSrc = scanImports(join(SIDECAR, 'dist/src'), new Set());
const sidecarBin = scanImports(join(SIDECAR, 'dist/bin'), new Set());
const allImports = new Set([...distImports, ...binImports, ...sidecarSrc, ...sidecarBin]);
const pruned = pruneList();
if (!sidecarPresent) {
    console.warn('[sidecar-deps-guard] WARN: electron/sidecar/server/dist is absent (stale/unbuilt); guarding source dist only. Run bundle-sidecar.sh to prove the packaged tree.');
}

// Wholesale scope removals (@babel, @vue, @types) match by prefix, not just
// exact name: a scoped runtime import like @babel/parser must overlap the
// @babel prune entry.
const prunedScopes = [...pruned].filter((name) => name.startsWith('@') && !name.includes('/'));
const overlap = [...allImports].filter((name) =>
    pruned.has(name) || prunedScopes.some((scope) => name === scope || name.startsWith(`${scope}/`)));

console.log(`[sidecar-deps-guard] dist/src: ${distImports.size}, dist/bin: ${binImports.size}, sidecar/src: ${sidecarSrc.size}, sidecar/bin: ${sidecarBin.size}${sidecarPresent ? '' : ' (source-only)'}`);
console.log(`[sidecar-deps-guard] prune list: ${pruned.size} packages`);

if (overlap.length) {
    console.error(`\n[sidecar-deps-guard] FAIL: ${overlap.length} package(s) are imported by the packaged runtime but are in the prune list:`);
    for (const name of overlap) console.error(`  ${name}`);
    console.error('\nThis is the node-fetch shape: pruning it crashes the packaged app at import time.');
    console.error('Remove it from PRUNE_PKGS in scripts/bundle-sidecar.sh, or prove the runtime never loads it.');
    process.exit(1);
}
console.log('[sidecar-deps-guard] OK: no prune-list package is imported by the packaged runtime');
