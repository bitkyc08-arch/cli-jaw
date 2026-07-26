// The packaged sidecar has now been broken twice by the same class of mistake:
// a package the server needs was on the prune list. First `node-fetch` itself.
// Then, after that was fixed, `web-streams-polyfill` — which is not
// frontend-only either, because node-fetch depends on fetch-blob and fetch-blob
// depends on it. The app died at boot with ERR_MODULE_NOT_FOUND for node-fetch
// while node-fetch was present, which is a confusing enough symptom that it
// cost a night.
//
// These tests pin both halves: the prune list itself must not name anything the
// server can reach, and the verifier that enforces that must actually detect a
// missing transitive dependency.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BUNDLE = join(ROOT, 'scripts', 'bundle-sidecar.sh');
const VERIFY = join(ROOT, 'scripts', 'verify-sidecar-deps.mjs');

/** The packages bundle-sidecar.sh deletes after installing production deps. */
function prunedPackages(): string[] {
    const script = readFileSync(BUNDLE, 'utf8');
    const listed = script.match(/PRUNE_PKGS=\(([\s\S]*?)\)/)?.[1] ?? '';
    const fromArray = [...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const fromRmLines = [...script.matchAll(/rm -rf "\$SIDECAR_DIR\/node_modules\/([^"]+)"/g)]
        .map((m) => m[1]!);
    return [...new Set([...fromArray, ...fromRmLines])];
}

test('the prune list does not name a package the server can reach', () => {
    const pruned = new Set(prunedPackages());
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
    };

    // Walk the production closure of every dependency that is NOT pruned. If a
    // pruned name turns up inside it, the server can reach it.
    const require = createRequire(join(ROOT, 'package.json'));
    const reachable = new Set<string>();
    const seen = new Set<string>();
    const walk = (name: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        let meta: { dependencies?: Record<string, string> };
        try { meta = require(`${name}/package.json`) as typeof meta; } catch { return; }
        for (const dep of Object.keys(meta.dependencies ?? {})) {
            if (pruned.has(dep)) reachable.add(dep);
            walk(dep);
        }
    };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (pruned.has(dep)) continue;   // pruned at the top level, on purpose
        walk(dep);
    }

    assert.deepEqual(
        [...reachable].sort(),
        [],
        'these pruned packages are reachable from a package the server keeps',
    );
});

test('the verifier reports a dependency removed from underneath a bundled package', () => {
    // Build a miniature sidecar: a kept package that depends on a second one,
    // then delete the second — exactly the shape of the real bug.
    const dir = mkdtempSync(join(tmpdir(), 'sidecar-prune-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'fixture-sidecar', version: '1.0.0', dependencies: { keeper: '1.0.0' },
    }));
    const keeper = join(dir, 'node_modules', 'keeper');
    mkdirSync(keeper, { recursive: true });
    writeFileSync(join(keeper, 'package.json'), JSON.stringify({
        name: 'keeper', version: '1.0.0', main: 'index.js', dependencies: { vanished: '1.0.0' },
    }));
    writeFileSync(join(keeper, 'index.js'), 'export default 1;\n');
    // `vanished` is deliberately never created.

    let code = 0;
    let output = '';
    try {
        output = execFileSync(process.execPath, [VERIFY, dir], { encoding: 'utf8' });
    } catch (error) {
        const e = error as { status?: number; stderr?: string };
        code = e.status ?? 0;
        output = e.stderr ?? '';
    }

    assert.equal(code, 1, 'the verifier must fail when a bundled package lost a dependency');
    assert.match(output, /vanished/, 'it must name the package that went missing');
});

test('the verifier passes when the closure is intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidecar-intact-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'fixture-sidecar', version: '1.0.0', dependencies: { keeper: '1.0.0' },
    }));
    for (const [name, deps] of [['keeper', { present: '1.0.0' }], ['present', {}]] as const) {
        const pkgDir = join(dir, 'node_modules', name);
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name, version: '1.0.0', main: 'index.js', dependencies: deps,
        }));
        writeFileSync(join(pkgDir, 'index.js'), 'export default 1;\n');
    }

    const output = execFileSync(process.execPath, [VERIFY, dir], { encoding: 'utf8' });
    assert.match(output, /OK:/);
});
