import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWebUiBuildOutput } from '../../scripts/check-web-ui-build-output.ts';

const ownedDirs: string[] = [];
test.after(() => { for (const dir of ownedDirs) rmSync(dir, { recursive: true, force: true }); });

function makeDist(indexHtml: string, appJs: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-build-output-'));
    ownedDirs.push(dir);
    const assets = join(dir, 'assets');
    mkdirSync(assets);
    writeFileSync(join(dir, 'index.html'), indexHtml);
    writeFileSync(join(assets, 'app-test.js'), appJs);
    for (const entry of ['manager', 'settings']) {
        mkdirSync(join(dir, entry));
        writeFileSync(join(dir, entry, 'index.html'), `<script type="module" src="/dist/assets/${entry}-test.js"></script>`);
        writeFileSync(join(assets, `${entry}-test.js`), 'export {};');
    }
    mkdirSync(join(dir, '.vite'));
    writeFileSync(join(dir, '.vite/manifest.json'), JSON.stringify(Object.fromEntries(
        [['index.html', 'app'], ['manager/index.html', 'manager'], ['settings/index.html', 'settings']].map(([src, name]) =>
            [src, { src, file: `assets/${name}-test.js`, isEntry: true }]),
    )));
    return dir;
}

test('build output guard passes dynamic mermaid-loader import', () => {
    const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', 'const m = () => import("./mermaid-loader-abc.js");');
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, true, result.errors.join('\n'));
});

test('build output guard fails eager modulepreload vendor-utils', () => {
    const dist = makeDist('<link rel="modulepreload" href="/dist/assets/vendor-utils-abc.js"><script type="module" src="/dist/assets/app-test.js"></script>', '');
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /modulepreloads vendor-utils/);
});

test('build output guard fails static vendor-utils import', () => {
    const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', 'import "./vendor-utils-abc.js";');
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /vendor-utils/);
});

test('build output guard fails __vite__mapDeps referencing vendor-mermaid', () => {
    const appJs = 'const deps = __vite__mapDeps(["./vendor-mermaid-abc.js","./chunk-xyz.js"]);';
    const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', appJs);
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /vendor-mermaid/);
});

test('build output guard fails when entry bytes exceed budget', () => {
    const bigJs = 'x'.repeat(1000);
    const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', bigJs);
    const result = checkWebUiBuildOutput({ distDir: dist, entryBudgetBytes: 500 });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /exceed budget/);
});

test('build output guard fails nested Vite publicDir artifacts', () => {
    const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', 'console.log("ok");');
    mkdirSync(join(dist, 'dist'));
    writeFileSync(join(dist, 'dist', 'index.html'), '<!doctype html>');
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Forbidden nested build output/);
});

for (const wrongEntry of ['app', 'manager']) test(`settings cannot reuse existing ${wrongEntry} bundle`, () => {
    const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', 'export {};');
    writeFileSync(join(dist, 'settings/index.html'), `<script type="module" src="/dist/assets/${wrongEntry}-test.js"></script>`);
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Entry bundle identity mismatch: settings\/index\.html/);
    writeFileSync(join(dist, 'settings/index.html'), '<script type="module" src="/dist/assets/settings-test.js"></script>');
    assert.equal(checkWebUiBuildOutput({ distDir: dist }).ok, true);
});

for (const [name, html] of [
    ['no script', '<main>Settings</main>'],
    ['no src', '<script type="module"></script>'],
    ['missing asset', '<script type="module" src="/dist/assets/missing.js"></script>'],
    ['source TS', '<script type="module" src="/manager/src/settings-standalone.tsx"></script>'],
    ['external origin', '<script type="module" src="https://other.invalid/dist/assets/settings-test.js"></script>'],
    ['query', '<script type="module" src="/dist/assets/settings-test.js?v=old"></script>'],
    ['duplicate script', '<script type="module" src="/dist/assets/settings-test.js"></script><script type="module" src="/dist/assets/settings-test.js"></script>'],
]) test(`settings entry rejects ${name}`, () => {
    const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', '');
    writeFileSync(join(dist, 'settings/index.html'), html!);
    assert.equal(checkWebUiBuildOutput({ distDir: dist }).ok, false);
});

for (const missing of ['settings/index.html', 'assets/settings-test.js', '.vite/manifest.json']) test(`build output rejects missing ${missing}`, () => {
    const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', '');
    rmSync(join(dist, missing));
    assert.equal(checkWebUiBuildOutput({ distDir: dist }).ok, false);
});

for (const manifest of ['{', 'null', JSON.stringify({ 'settings/index.html': { src: 'settings/index.html', file: 'assets/settings-test.js', isEntry: false } }),
    JSON.stringify({ 'settings/index.html': { src: 'manager/index.html', file: 'assets/settings-test.js', isEntry: true } })]) {
    test(`invalid manifest identity: ${manifest}`, () => {
        const dist = makeDist('<script type="module" src="/dist/assets/app-test.js"></script>', '');
        writeFileSync(join(dist, '.vite/manifest.json'), manifest);
        const result = checkWebUiBuildOutput({ distDir: dist });
        assert.equal(result.ok, false);
        assert.match(result.errors.join('\n'), /Missing or invalid build manifest|Missing entry identity: settings/);
    });
}
