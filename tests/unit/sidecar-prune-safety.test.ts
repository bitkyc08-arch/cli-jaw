// The sidecar bundle deletes "frontend-only" packages to keep the desktop app
// from carrying ~244MB of browser libraries. The list was hand-written and
// wrong from the commit that introduced it: node-fetch was on it while
// src/telegram/bot.ts imports it, so every packaged app died with
// ERR_MODULE_NOT_FOUND the moment the Telegram module loaded.
//
// These tests RUN the checker against mutated copies of the shell script.
// Asserting on its source would have passed throughout the outage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const checker = join(projectRoot, 'scripts', 'check-sidecar-prune-safety.mjs');
const bundleScript = join(projectRoot, 'scripts', 'bundle-sidecar.sh');

const runChecker = () => spawnSync('node', [checker], {
    cwd: projectRoot, encoding: 'utf8', timeout: 60_000,
});

test('the shipped prune list is safe', () => {
    const r = runChecker();
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /removes nothing the server needs/);
});

test('node-fetch and its transitive dep are no longer pruned', () => {
    // The two halves of the original defect. node-fetch was in PRUNE_PKGS and
    // web-streams-polyfill had its own rm -rf line, reached through
    // node-fetch -> fetch-blob, so removing only the first would still break.
    const script = readFileSync(bundleScript, 'utf8');
    const pruneBlock = script.match(/PRUNE_PKGS=\(([\s\S]*?)\n\)/)?.[1] ?? '';

    assert.doesNotMatch(pruneBlock, /"node-fetch"/,
        'node-fetch is imported by src/telegram/bot.ts and must ship');
    assert.doesNotMatch(script, /rm -rf "\$SIDECAR_DIR\/node_modules\/web-streams-polyfill"/,
        'web-streams-polyfill is reached via node-fetch -> fetch-blob');
});

test('the bundle script refuses to build with an unsafe list', () => {
    // Wiring matters as much as the checker: a checker nobody calls is a
    // comment. The bundle script must run it before it does any work.
    const script = readFileSync(bundleScript, 'utf8');
    const checkAt = script.indexOf('check-sidecar-prune-safety.mjs');
    const pruneAt = script.indexOf('PRUNE_PKGS=(');
    const copyAt = script.indexOf('Copying server artifacts');

    assert.ok(checkAt > 0, 'bundle-sidecar.sh never runs the prune-safety check');
    assert.ok(checkAt < pruneAt, 'the check must run before the prune list is applied');
    assert.ok(checkAt < copyAt, 'the check must run before any bundling work');
});

test('adding a server dependency back to the list fails the checker', () => {
    // Mutation, driven through a real run rather than reasoning: put a package
    // the server imports back on the list and the checker must object by name.
    const original = readFileSync(bundleScript, 'utf8');
    const mutated = original.replace('  "d3" "dompurify"', '  "d3" "dompurify" "node-fetch"');
    assert.notEqual(mutated, original, 'the prune list moved; this mutation no longer applies');

    try {
        writeFileSync(bundleScript, mutated);
        const r = runChecker();
        assert.notEqual(r.status, 0, 'a pruned runtime dependency must fail the checker');
        assert.match(r.stderr, /node-fetch/);
        assert.match(r.stderr, /imported directly by server source/);
    } finally {
        writeFileSync(bundleScript, original);
    }

    // Leave no doubt the tree was restored.
    assert.equal(readFileSync(bundleScript, 'utf8'), original);
    assert.equal(runChecker().status, 0, 'the checker did not return to passing');
});

test('the gate is registered and addressable', () => {
    const gates = readFileSync(join(projectRoot, 'scripts', 'release-gates.mjs'), 'utf8');
    assert.match(gates, /'sidecar-prune-safety':\s*\{/, 'the gate is not in GATES');

    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as
        { scripts: Record<string, string> };
    assert.equal(pkg.scripts["gate:sidecar-prune-safety"],
        'node scripts/release-gates.mjs sidecar-prune-safety');
});
