import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

interface ManifestNode {
    file: string;
    imports?: string[];
    dynamicImports?: string[];
}

const manifestUrl = new URL('../../public/dist/.vite/manifest.json', import.meta.url);

function readManifest(): Record<string, ManifestNode> {
    assert.ok(
        existsSync(manifestUrl),
        'public/dist/.vite/manifest.json is missing; run npm run build:frontend before this bundle gate',
    );
    return JSON.parse(readFileSync(manifestUrl, 'utf8')) as Record<string, ManifestNode>;
}

function staticGraph(manifest: Record<string, ManifestNode>, root: string, maxDepth = 5): Set<string> {
    const seen = new Set<string>();
    const visit = (key: string, depth: number): void => {
        if (depth > maxDepth || seen.has(key)) return;
        seen.add(key);
        for (const imported of manifest[key]?.imports ?? []) visit(imported, depth + 1);
    };
    visit(root, 0);
    return seen;
}

test('061 initial dashboard bundle contains only the dynamic Code gate boundary', () => {
    const manifest = readManifest();
    const entry = manifest['dashboard2/index.html'];
    assert.ok(entry, 'dashboard2/index.html manifest entry is required');
    assert.equal((entry.imports ?? []).some(key => /code\//.test(key)), false);
    assert.ok(entry.dynamicImports?.includes('dashboard2/src/code/index.ts'));
});

test('061 gate graph excludes CodeTab and the heavy source adapter', () => {
    const manifest = readManifest();
    const gateKey = 'dashboard2/src/code/index.ts';
    const gate = manifest[gateKey];
    assert.ok(gate, `${gateKey} manifest node is required`);
    const graph = staticGraph(manifest, gateKey);
    assert.equal(graph.has('dashboard2/src/code/CodeTab.tsx'), false);
    assert.equal([...graph].some(key => /code-source-adapter\.ts$/.test(key)), false);
    assert.ok(gate.dynamicImports?.includes('dashboard2/src/code/CodeTab.tsx'));
});

test('061 CodeTab owns a distinct chunk containing the source adapter implementation', () => {
    const manifest = readManifest();
    const codeTabKey = 'dashboard2/src/code/CodeTab.tsx';
    const codeTab = manifest[codeTabKey];
    assert.ok(codeTab, `${codeTabKey} manifest node is required`);
    assert.ok(codeTab.file);
    const graph = staticGraph(manifest, codeTabKey);
    const graphContent = [...graph].map(key => {
        const file = manifest[key]?.file;
        return file ? readFileSync(new URL(`../../public/dist/${file}`, import.meta.url), 'utf8') : '';
    }).join('\n');
    assert.match(graphContent, /codeturn:/, 'CodeTab static bundle graph must contain code-source-adapter output');
});

test('061 entry chunk has no Code adapter implementation markers', () => {
    const manifest = readManifest();
    const entry = manifest['dashboard2/index.html'];
    assert.ok(entry, 'dashboard2/index.html manifest entry is required');
    const content = readFileSync(new URL(`../../public/dist/${entry.file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /codeturn:|code-source-adapter/);
});
