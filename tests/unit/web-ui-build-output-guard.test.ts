import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWebUiBuildOutput } from '../../scripts/check-web-ui-build-output.ts';

function makeDist(indexHtml: string, appJs: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-build-output-'));
    const assets = join(dir, 'assets');
    mkdirSync(assets);
    writeFileSync(join(dir, 'index.html'), indexHtml);
    writeFileSync(join(assets, 'app-test.js'), appJs);
    mkdirSync(join(dir, 'manager'));
    writeFileSync(join(dir, 'manager', 'index.html'), '<!doctype html>');
    writeFileSync(join(assets, 'manager-test.js'), 'console.log("manager");');
    mkdirSync(join(dir, 'dashboard2'));
    writeFileSync(join(dir, 'dashboard2', 'index.html'), '<!doctype html>');
    writeFileSync(join(assets, 'dashboard2-test.js'), 'console.log("dashboard2");');
    return dir;
}

test('build output guard passes dynamic mermaid-loader import', () => {
    const dist = makeDist('<script type="module" src="/assets/app-test.js"></script>', 'const m = () => import("./mermaid-loader-abc.js");');
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, true, result.errors.join('\n'));
});

test('build output guard fails eager modulepreload vendor-utils', () => {
    const dist = makeDist('<link rel="modulepreload" href="/assets/vendor-utils-abc.js"><script type="module" src="/assets/app-test.js"></script>', '');
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /modulepreloads vendor-utils/);
});

test('build output guard fails static vendor-utils import', () => {
    const dist = makeDist('<script type="module" src="/assets/app-test.js"></script>', 'import "./vendor-utils-abc.js";');
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /vendor-utils/);
});

test('build output guard fails __vite__mapDeps referencing vendor-mermaid', () => {
    const appJs = 'const deps = __vite__mapDeps(["./vendor-mermaid-abc.js","./chunk-xyz.js"]);';
    const dist = makeDist('<script type="module" src="/assets/app-test.js"></script>', appJs);
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /vendor-mermaid/);
});

test('build output guard fails when entry bytes exceed budget', () => {
    const bigJs = 'x'.repeat(1000);
    const dist = makeDist('<script type="module" src="/assets/app-test.js"></script>', bigJs);
    const result = checkWebUiBuildOutput({ distDir: dist, entryBudgetBytes: 500 });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /exceed budget/);
});

test('build output guard fails nested Vite publicDir artifacts', () => {
    const dist = makeDist('<script type="module" src="/assets/app-test.js"></script>', 'console.log("ok");');
    mkdirSync(join(dist, 'dist'));
    writeFileSync(join(dist, 'dist', 'index.html'), '<!doctype html>');
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Forbidden nested build output/);
});

test('build output guard fails when dashboard2 entry html is missing', () => {
    const dist = makeDist('<script type="module" src="/assets/app-test.js"></script>', 'console.log("ok");');
    rmSync(join(dist, 'dashboard2', 'index.html'));
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Missing .*dashboard2.*index\.html/);
});

test('build output guard fails when dashboard2 entry js is missing', () => {
    const dist = makeDist('<script type="module" src="/assets/app-test.js"></script>', 'console.log("ok");');
    rmSync(join(dist, 'assets', 'dashboard2-test.js'));
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /No dashboard2-\*\.js entry/);
});

test('build output guard fails when manager entry html is missing', () => {
    const dist = makeDist('<script type="module" src="/assets/app-test.js"></script>', 'console.log("ok");');
    rmSync(join(dist, 'manager', 'index.html'));
    const result = checkWebUiBuildOutput({ distDir: dist });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Missing .*manager.*index\.html/);
});
