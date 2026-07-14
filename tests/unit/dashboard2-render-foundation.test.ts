import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { markdownParityFixtures } from '../fixtures/dashboard2/render-parity/markdown.js';
import { xssNegativeFixtures, xssPositiveFixtures } from '../fixtures/dashboard2/render-parity/xss.js';
import { renderCopy, renderCopyCatalog } from '../../public/dashboard2/src/turn-stream/render/copy-catalog.js';
import { preParseMarkdown } from '../../public/dashboard2/src/turn-stream/render/pre-parse.js';
import { createParseCoalescer, renderFinalMarkdown } from '../../public/dashboard2/src/turn-stream/render/parse-coalescer.js';
import { RenderCacheManager, contentHash, heightCacheKey, markdownCacheKey, rendererVersion } from '../../public/dashboard2/src/turn-stream/render/render-cache.js';
import { sanitizeHtml, sanitizePolicyVersion, sanitizedHtmlProps } from '../../public/dashboard2/src/turn-stream/render/sanitize-policy.js';

test('pre-parse strips only orchestration leakage, then fixes CJK, idempotently', () => {
    const raw = '**끝!)**다음\n```json\n{"subtasks":[]}\n```';
    const once = preParseMarkdown(raw);
    assert.match(once.source, /!\)\u200B\*\*다음/);
    assert.doesNotMatch(once.source, /subtasks/);
    assert.deepEqual(preParseMarkdown(once.source).source, once.source);
    assert.match(preParseMarkdown('```json\n{"phase":"normal"}\n```').source, /phase/);
    assert.doesNotMatch(raw, /\u200B/);
});

test('sanitizer profiles enforce URL, attribute, tag, and class boundaries', () => {
    const dom = new JSDOM('<!doctype html>');
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    for (const fixture of xssNegativeFixtures) {
        const html = sanitizeHtml(fixture, 'markdown');
        assert.doesNotMatch(html, /(?:script|iframe|style=|onerror|onclick|onload|javascript:|data:)/i);
    }
    const positive = sanitizeHtml(xssPositiveFixtures.markdown, 'markdown');
    assert.match(positive, /\.\/safe\/path/); assert.match(positive, /https:/); assert.match(positive, /mailto:/);
    const highlight = sanitizeHtml(`${xssPositiveFixtures.highlight}<b style="x">bad</b>`, 'highlight');
    assert.match(highlight, /language-ts/); assert.match(highlight, /token keyword/); assert.doesNotMatch(highlight, /<b|style=/);
    assert.deepEqual(sanitizedHtmlProps(highlight), { __html: highlight });
    assert.match(sanitizePolicyVersion, /\d/);
    delete (globalThis as { window?: unknown }).window;
});

test('cache contracts cover limits, LRU, live scope, keys, and width buckets', () => {
    const cache = new RenderCacheManager();
    for (let index = 0; index < 260; index += 1) cache.set('markdown', String(index), `v${index}`);
    assert.equal(cache.stats('markdown').count, 256);
    assert.equal(cache.get('markdown', '0'), undefined);
    assert.equal(cache.set('highlight', 'giant', 'x'.repeat(600_000)), false);
    cache.setScope('a'); cache.set('markdown', 'pinned', 'p'); cache.pin('markdown', 'pinned'); cache.setLiveMarkdown('a', '1', sanitizeHtml('x', 'markdown'));
    cache.setLiveMarkdown('a', '2', sanitizeHtml('y', 'markdown'));
    assert.equal(cache.getLiveMarkdown('a')?.key, '2'); cache.setScope('b'); assert.equal(cache.getLiveMarkdown('a'), null);
    const base = { threadId: 't', turnId: 'u', contentRevision: 1, fontMetricsVersion: 'f', fontScale: 1, expansionFingerprint: 'e' };
    assert.equal(heightCacheKey({ ...base, widthPx: 65 }), heightCacheKey({ ...base, widthPx: 127 }));
    assert.notEqual(heightCacheKey({ ...base, widthPx: 127 }), heightCacheKey({ ...base, widthPx: 128 }));
    assert.match(markdownCacheKey(contentHash('x')), new RegExp(`${rendererVersion}.*${sanitizePolicyVersion}`));
});

test('copy catalogs have identical coverage and interpolate', () => {
    assert.deepEqual(Object.keys(renderCopyCatalog.ko).sort(), Object.keys(renderCopyCatalog.en).sort());
    assert.equal(renderCopy('en', 'tool.label', { seq: 3 }), 'Tool 3');
    assert.match(renderCopy('ko', 'stream.oversizeNotice', { sizeKiB: 300 }), /300/);
});

test('stream append cuts never throw and final output equals one-shot', () => {
    for (const fixture of markdownParityFixtures.filter(({ source }) => source.length <= 64 * 1024)) {
        const scheduled: Array<() => void> = []; let published = null;
        const coalescer = createParseCoalescer({ identity: { scopeKey: fixture.name, turnId: 't', segmentId: 's' }, onPublish: value => { published = value; }, schedule: (_delay, callback) => { scheduled.push(callback); return callback; }, cancel: () => {} });
        const cuts: number[] = [];
        for (let index = 0; index <= fixture.source.length; index += 1) if (!(index > 0 && /[\uD800-\uDBFF]/.test(fixture.source[index - 1]))) cuts.push(index);
        for (const cut of cuts) assert.doesNotThrow(() => { coalescer.update(fixture.source.slice(0, cut)); scheduled.splice(0).forEach(callback => callback()); });
        const final = coalescer.flushFinal(fixture.source);
        assert.equal(final.html, renderFinalMarkdown(fixture.source).html); assert.ok(published);
    }
});

test('dashboard2 HTML sinks stay on the approved allowlist', () => {
    const root = join(process.cwd(), 'public/dashboard2/src'); const found: string[] = [];
    const walk = (dir: string): void => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.tsx?$/.test(path) && readFileSync(path, 'utf8').includes('dangerouslySetInnerHTML')) found.push(path.slice(root.length + 1)); } };
    walk(root);
    const allowed = new Set(['turn-stream/components/MarkdownSegment.tsx', 'features/panels/DocPanel.tsx', 'features/notes/rendering/CodeBlock.tsx', 'shell/Icon.tsx']);
    assert.deepEqual(found.filter(path => !allowed.has(path)), [], 'New HTML sinks must use turn-stream/render/sanitize-policy.ts and be explicitly allowlisted');
});
