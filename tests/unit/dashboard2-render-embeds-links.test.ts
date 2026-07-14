import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { diffFixtures, imageFixtures, pathFixtures } from '../fixtures/dashboard2/render-parity/r3-embeds-links.js';
import { parseUnifiedDiffRows } from '../../public/dashboard2/src/turn-stream/render/embeds/UnifiedDiffSegment.js';
import { resolveImageSource } from '../../public/dashboard2/src/turn-stream/render/embeds/ImageSegment.js';
import { collectPathHits, linkifyFilePaths, teardownFilePathLinks } from '../../public/dashboard2/src/turn-stream/render/links/file-path-linkifier.js';

test('diff rows preserve prefixes, semantics, and cap', () => {
    const parsed = parseUnifiedDiffRows(diffFixtures.rows801);
    assert.equal(parsed.rows.length, 800); assert.equal(parsed.omitted, 1);
    assert.deepEqual(parsed.rows.slice(0, 4).map(row => row.kind), ['file', 'file', 'hunk', 'add']);
    assert.equal(parsed.rows[3].text[0], '+');
});

test('image routing gives uploads precedence and preserves web URLs', () => {
    for (const fixture of imageFixtures.filter((item): item is { src: string; route: string } => 'route' in item)) assert.equal(resolveImageSource(fixture.src), fixture.route);
    assert.equal(resolveImageSource('~/image.png'), '/api/image?path=~%2Fimage.png');
});

test('path scanner trims punctuation and rejects dates, URLs, and fractions', () => {
    for (const path of pathFixtures.valid) assert.equal(collectPathHits(`See ${path},`)[0]?.path, path);
    for (const path of pathFixtures.invalid) assert.deepEqual(collectPathHits(path), []);
    const overlap = collectPathHits('./src/components/App.tsx'); assert.equal(overlap.length, 1);
});

test('DOM adapter skips protected trees, is idempotent, and teardown preserves slots', () => {
    const dom = new JSDOM('<div id="host">/tmp/a.ts <pre>/tmp/b.ts</pre><span data-render-slot="x">/tmp/c.ts</span></div>');
    Object.assign(globalThis, { document: dom.window.document, NodeFilter: dom.window.NodeFilter });
    const host = dom.window.document.querySelector<HTMLElement>('#host')!;
    linkifyFilePaths(host); linkifyFilePaths(host);
    assert.equal(host.querySelectorAll('[data-file-link]').length, 1);
    assert.equal(host.querySelector('[data-render-slot]')?.textContent, '/tmp/c.ts');
    teardownFilePathLinks(host);
    assert.equal(host.querySelectorAll('[data-file-link]').length, 0);
    assert.ok(host.querySelector('[data-render-slot]'));
});
