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
});
