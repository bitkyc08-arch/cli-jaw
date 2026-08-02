import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const gateScript = path.join(repoRoot, 'scripts', 'release-gates.mjs');

function runGate(name: string): { status: number; stdout: string; stderr: string } {
    const r = spawnSync('node', [gateScript, name], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('phase22 named release gates (cli-jaw)', () => {
    it('release-gates.mjs exists and is executable as a script', () => {
        assert.ok(fs.existsSync(gateScript), 'scripts/release-gates.mjs must exist');
    });

    it('truth-table-fresh gate passes', () => {
        const r = runGate('truth-table-fresh');
        assert.equal(r.status, 0, `expected pass, got: ${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /\[PASS\] gate:truth-table-fresh/);
    });

    it('mcp-scope-frozen gate passes (cli-jaw exposes no browser MCP tools)', () => {
        const r = runGate('mcp-scope-frozen');
        assert.equal(r.status, 0, `expected pass, got: ${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /\[PASS\] gate:mcp-scope-frozen/);
    });

    it('no-experimental-in-readme-ready-section gate passes', () => {
        const r = runGate('no-experimental-in-readme-ready-section');
        assert.equal(r.status, 0, `expected pass, got: ${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /\[PASS\] gate:no-experimental-in-readme-ready-section/);
    });

    it('unknown gate name fails fast', () => {
        const r = runGate('definitely-not-a-real-gate');
        assert.notEqual(r.status, 0);
        assert.match(r.stdout, /unknown gate/);
    });

    it('truth table mentions the four mirrored agbrowse symbols', () => {
        const text = fs.readFileSync(path.join(repoRoot, 'structure/CAPABILITY_TRUTH_TABLE.md'), 'utf8');
        for (const term of ['action-intent', 'target-resolver', 'answer-artifact', 'source-audit']) {
            assert.ok(text.includes(term), `truth table must reference ${term}`);
        }
    });

    describe('gate-docs keeps the documented gate list honest', () => {
        // structure/INDEX.md hardcodes the gate count and every name. Adding a
        // gate made that row wrong and nothing noticed, because check-docs.mts
        // counts only routes and endpoints. These tests drive the gate against
        // real mutated copies of the doc -- asserting on the gate's source text
        // would have stayed green through exactly the drift it exists to catch.
        const indexPath = path.join(repoRoot, 'structure/INDEX.md');

        /** Run gate-docs against a temporarily mutated structure/INDEX.md. */
        function withMutatedIndex(mutate: (row: string) => string) {
            const original = fs.readFileSync(indexPath, 'utf8');
            const row = original.split('\n').find((line) =>
                line.includes('named gates') && line.includes('runs all'));
            assert.ok(row, 'the release-gates row is missing from structure/INDEX.md');
            try {
                fs.writeFileSync(indexPath, original.replace(row, mutate(row)));
                return runGate('gate-docs');
            } finally {
                fs.writeFileSync(indexPath, original);
            }
        }

        it('passes on the committed docs', () => {
            const r = runGate('gate-docs');
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /\[PASS\] gate:gate-docs/);
        });

        it('catches a stale count', () => {
            const r = withMutatedIndex((row) => row.replace(/runs all \d+ named gates/, 'runs all 3 named gates'));
            assert.notEqual(r.status, 0, 'a wrong count must fail');
            assert.match(r.stdout, /count says 3, GATES has \d+/);
        });

        it('catches a gate that exists but is undocumented', () => {
            const r = withMutatedIndex((row) => row.replace('`electron-version`, ', ''));
            assert.notEqual(r.status, 0, 'a missing gate name must fail');
            assert.match(r.stdout, /undocumented: electron-version/);
        });

        it('catches a documented gate that no longer exists', () => {
            // The whole-row-plus-filter approach passed this case: a token
            // shaped like a gate mention was indistinguishable from a retired
            // gate. Reading only the parenthesised list makes it fatal.
            const r = withMutatedIndex((row) => row.replace('`doc-drift`', '`doc-drift-v2`'));
            assert.notEqual(r.status, 0, 'a phantom gate must fail');
            assert.match(r.stdout, /documented but gone: doc-drift-v2/);
        });

        it('does not accuse backticked prose outside the gate list', () => {
            // The earlier draft scanned the entire row, so an ordinary
            // backticked word in the surrounding sentence was reported as a
            // retired gate. The list is scoped to the parenthetical now.
            const r = withMutatedIndex((row) => row.replace(
                'each is npm-addressable', 'each is `npm`-addressable'));
            assert.equal(r.status, 0, `innocent prose was flagged: ${r.stdout}`);
        });

        it('requires every gate to have its npm script', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as
                { scripts: Record<string, string> };
            const src = fs.readFileSync(gateScript, 'utf8');
            const names = [...src.matchAll(/^ {4}'([a-z0-9-]+)': \{$/gm)].map((m) => m[1]);
            assert.ok(names.length > 0, 'could not read the gate names');
            for (const name of names) {
                assert.equal(pkg.scripts[`gate:${name}`], `node scripts/release-gates.mjs ${name}`,
                    `gate:${name} is not npm-addressable, which structure/INDEX.md promises`);
            }
        });
    });
});
