import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWebUiBuildOutput } from '../../scripts/check-web-ui-build-output.ts';

interface SyntheticBundle {
    manifest?: Record<string, { file: string; imports?: string[]; dynamicImports?: string[] }>;
    files?: Record<string, string | Uint8Array>;
}

function makeDist(indexHtml: string, appJs: string, bundle: SyntheticBundle = {}): string {
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
    mkdirSync(join(dir, '.vite'));
    const manifest = bundle.manifest ?? {
        'dashboard2/index.html': { file: 'assets/dashboard2-test.js' },
    };
    writeFileSync(join(dir, '.vite', 'manifest.json'), JSON.stringify(manifest));
    for (const [relativePath, content] of Object.entries(bundle.files ?? {})) {
        const target = join(dir, relativePath);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, content);
    }
    return dir;
}

function renderManifest(overrides: SyntheticBundle = {}): SyntheticBundle {
    return {
        manifest: {
            'dashboard2/index.html': { file: 'assets/dashboard2-test.js', dynamicImports: ['dashboard2/src/turn-stream/render/highlight-service.ts'] },
            'dashboard2/src/turn-stream/render/highlight-service.ts': { file: 'assets/highlight-service-test.js', dynamicImports: ['node_modules/@shikijs/core/dist/index.mjs'] },
            'node_modules/@shikijs/core/dist/index.mjs': { file: 'assets/render-shiki-test.js' },
            ...overrides.manifest,
        },
        files: {
            'assets/highlight-service-test.js': 'new Worker(new URL("./highlight-worker-test.js", import.meta.url),{type:"module"});',
            'assets/render-shiki-test.js': 'export const shiki = true;',
            'assets/highlight-worker-test.js': 'self.onmessage = () => {};',
            ...overrides.files,
        },
    };
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

test('build output guard fails eager Shiki in dashboard2 static graph', () => {
    const bundle = renderManifest();
    bundle.manifest!['dashboard2/index.html'].imports = ['node_modules/@shikijs/core/dist/index.mjs'];
    const result = checkWebUiBuildOutput({ distDir: makeDist('<!doctype html>', '', bundle) });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /static import closure contains Shiki/);
});

test('build output guard fails oversized Shiki lazy aggregate', () => {
    const bundle = renderManifest({ files: { 'assets/render-shiki-test.js': randomBytes(451 * 1024) } });
    const result = checkWebUiBuildOutput({ distDir: makeDist('<!doctype html>', '', bundle) });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /lazy aggregate gzip .* exceeds/);
});

test('build output guard fails when highlight service has no render-shiki lazy chunk', () => {
    const bundle = renderManifest();
    bundle.manifest!['dashboard2/src/turn-stream/render/highlight-service.ts'].dynamicImports = [];
    const result = checkWebUiBuildOutput({ distDir: makeDist('<!doctype html>', '', bundle) });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no render-shiki lazy chunk/);
});

test('build output guard fails when emitted highlight worker is missing', () => {
    const bundle = renderManifest({ files: { 'assets/highlight-service-test.js': 'export const service = true;' } });
    delete bundle.files!['assets/highlight-worker-test.js'];
    const result = checkWebUiBuildOutput({ distDir: makeDist('<!doctype html>', '', bundle) });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /worker file was not found/);
});

test('build output guard fails KaTeX in dashboard2 static graph', () => {
    const bundle = renderManifest();
    bundle.manifest!['dashboard2/index.html'].imports = ['node_modules/katex/dist/katex.mjs'];
    bundle.manifest!['node_modules/katex/dist/katex.mjs'] = { file: 'assets/render-katex-test.js' };
    const result = checkWebUiBuildOutput({ distDir: makeDist('<!doctype html>', '', bundle) });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /static import closure contains KaTeX/);
});

test('build output guard fails Mermaid in dashboard2 static graph', () => {
    const bundle = renderManifest();
    bundle.manifest!['dashboard2/index.html'].imports = ['node_modules/mermaid/dist/mermaid.esm.mjs'];
    bundle.manifest!['node_modules/mermaid/dist/mermaid.esm.mjs'] = { file: 'assets/mermaid-test.js' };
    const result = checkWebUiBuildOutput({ distDir: makeDist('<!doctype html>', '', bundle) });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /static import closure contains Mermaid/);
});

test('build output guard passes valid dynamic Shiki graph with emitted worker', () => {
    const result = checkWebUiBuildOutput({ distDir: makeDist('<!doctype html>', '', renderManifest()) });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.dashboard2Bundle?.staticShikiCount, 0);
    assert.deepEqual(result.dashboard2Bundle?.lazyFiles.sort(), ['assets/highlight-worker-test.js', 'assets/render-shiki-test.js']);
});
