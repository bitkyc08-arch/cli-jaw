import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { mermaidFixtures } from '../fixtures/dashboard2/render-parity/r3-embeds-links.js';
import { getMermaidInitConfig, detectMermaidDiagramType } from '../../public/dashboard2/src/turn-stream/render/embeds/mermaid-config.js';
import { preprocessMermaid, sanitizeMermaidForRetry } from '../../public/dashboard2/src/turn-stream/render/embeds/mermaid-preprocess.js';
import { RenderCacheManager, heightCacheKey } from '../../public/dashboard2/src/turn-stream/render/render-cache.js';
import { sanitizeHtml, sanitizeMermaidStyle } from '../../public/dashboard2/src/turn-stream/render/sanitize-policy.js';

function installDom(): JSDOM {
    const dom = new JSDOM('<!doctype html><html data-theme="light"><body></body></html>');
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'getComputedStyle', { value: dom.window.getComputedStyle.bind(dom.window), configurable: true });
    for (const name of ['Element', 'HTMLElement', 'SVGElement', 'CSSStyleSheet'] as const) {
        Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
    }
    Object.defineProperty(dom.window.SVGElement.prototype, 'getComputedTextLength', { configurable: true, value() { return (this.textContent?.length ?? 0) * 8; } });
    Object.defineProperty(dom.window.SVGElement.prototype, 'getBBox', { configurable: true, value() { return { x: 0, y: 0, width: 80, height: 20 }; } });
    return dom;
}

test('config keeps strict legacy semantics and reads resolved CSS variables', () => {
    const dom = installDom();
    dom.window.document.documentElement.style.setProperty('--surface', '#abcdef');
    const config = getMermaidInitConfig('light') as { [key: string]: unknown; themeVariables: Record<string, string> };
    assert.equal(config.startOnLoad, false); assert.equal(config.theme, 'base'); assert.equal(config.htmlLabels, false);
    assert.equal(config.securityLevel, 'strict'); assert.equal(config.suppressErrorRendering, true);
    assert.equal(config.themeVariables.primaryColor, '#abcdef');
    assert.equal(detectMermaidDiagramType('%% comment\n---\nsequenceDiagram'), 'sequencediagram');
});

test('preprocess and retry sanitizer preserve legacy parity and idempotence', () => {
    const once = preprocessMermaid('flowchart TD\r\nsrc/index[File];\rdefault[Done];');
    assert.equal(preprocessMermaid(once), once);
    assert.match(once, /src_index\[File\]/); assert.match(once, /node_default\[Done\]/);
    const retry = sanitizeMermaidForRetry(preprocessMermaid(mermaidFixtures.malformedFlowchart));
    assert.match(retry ?? '', /src_index\["설정\(config\) & 초기화"\]/);
    assert.equal(sanitizeMermaidForRetry('sequenceDiagram\nA->>B: hello'), null);
});

test('Mermaid embed namespace enforces count, byte LRU, touch, giant skip, and height isolation', () => {
    const cache = new RenderCacheManager();
    for (let index = 0; index < 64; index += 1) cache.setEmbed('mermaid', String(index), `svg-${index}`);
    cache.getEmbed('mermaid', '0'); cache.setEmbed('mermaid', '64', 'last');
    assert.equal(cache.embedStats('mermaid').count, 64); assert.equal(cache.getEmbed('mermaid', '1'), undefined); assert.equal(cache.getEmbed('mermaid', '0'), 'svg-0');
    const bytesCache = new RenderCacheManager();
    for (let index = 0; index < 5; index += 1) bytesCache.setEmbed('mermaid', String(index), 'x', 1_400_000);
    assert.ok(bytesCache.embedStats('mermaid').bytes <= 6 * 1024 * 1024);
    assert.equal(bytesCache.setEmbed('mermaid', 'giant', 'x', 1_600_000), false);
    assert.ok(new TextEncoder().encode(mermaidFixtures.oversizeSource()).byteLength > 128 * 1024);
    const base = { contentRevision: 1, widthPx: 640, fontMetricsVersion: 'f', fontScale: 1, expansionFingerprint: 'e' };
    const target = heightCacheKey({ ...base, threadId: 'scope', turnId: 'turn' });
    const other = heightCacheKey({ ...base, threadId: 'scope', turnId: 'other' });
    cache.set('height', target, 100); cache.set('height', other, 200); cache.set('markdown', 'keep', 'yes');
    cache.invalidateHeights({ scopeKey: 'scope', turnId: 'turn' });
    assert.equal(cache.get('height', target), undefined); assert.equal(cache.get('height', other), 200); assert.equal(cache.get('markdown', 'keep'), 'yes');
});

test('mermaid SVG profile retains safe diagrams and local scoped styles', () => {
    installDom();
    const safe = '<svg viewBox="0 0 10 10" role="img"><style>#node,.edge{fill:#fff;stroke:url(#arrow);position:fixed}tag{fill:red}</style><defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs><g id="node" class="node"><rect width="10" height="10"/><text><tspan>Flow</tspan></text></g></svg>';
    const clean = sanitizeHtml(safe, 'mermaid-svg');
    assert.match(clean, /<svg/); assert.match(clean, /<marker/); assert.match(clean, /fill:#fff/); assert.match(clean, /stroke:url\(#arrow\)/);
    assert.doesNotMatch(clean, /position|tag\{/);
    assert.equal(sanitizeMermaidStyle('.node{fill:red;position:fixed}.edge{stroke:blue}'), '.node{fill:red}.edge{stroke:blue}');
});

test('mermaid SVG profile strips executable and external content', () => {
    installDom();
    const dirty = '<svg onload="x"><foreignObject><p>x</p></foreignObject><script>x</script><a href="https://evil.test"><text>x</text></a><image href="https://evil.test/x"/><use href="https://evil.test/x#y"/><path onclick="x" marker-end="url(https://evil.test/x)"/></svg>';
    const clean = sanitizeHtml(dirty, 'mermaid-svg');
    assert.doesNotMatch(clean, /foreignObject|script|<a|image|onload|onclick|evil\.test/i);
    assert.doesNotMatch(clean, /<use[^>]+(?:href|xlink:href)/i);
});

test('real Mermaid smoke produces non-empty sanitized SVG', async () => {
    const dom = installDom();
    const purifier = (createDOMPurify as unknown as (window: Window) => { sanitize(value: string): string })(dom.window as unknown as Window);
    mock.module('dompurify', { defaultExport: purifier });
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize(getMermaidInitConfig('light'));
    const { svg } = await mermaid.render('real-mermaid-smoke', 'flowchart TD\nRealA[One] --> RealB[Two]');
    const clean = sanitizeHtml(svg, 'mermaid-svg');
    assert.match(clean, /<svg[\s\S]+<path/);
    mock.restoreAll();
});

test('runtime serializes renders, survives a failed tail, and drops stale commits', async () => {
    installDom();
    const calls: string[] = []; let active = 0; let maxActive = 0;
    const render = mock.fn(async (_id: string, source: string) => {
        active += 1; maxActive = Math.max(maxActive, active); calls.push(source);
        await Promise.resolve(); active -= 1;
        if (source.includes('bad')) throw new Error('bad diagram');
        return { svg: `<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>` };
    });
    mock.module('mermaid', { defaultExport: { initialize() {}, render } });
    const runtime = await import('../../public/dashboard2/src/turn-stream/render/embeds/mermaid-runtime.js');
    runtime.resetMermaidRuntimeForTests();
    const bad = runtime.renderMermaid({ source: 'sequenceDiagram\nbad', resolvedTheme: 'light', generation: 1 });
    const good = runtime.renderMermaid({ source: 'flowchart TD\nA-->B', resolvedTheme: 'light', generation: 2 });
    assert.equal((await bad).status, 'error'); assert.equal((await good).status, 'ready'); assert.equal(maxActive, 1);
    const stale = await runtime.renderMermaid({ source: 'flowchart TD\nC-->D', resolvedTheme: 'dark', generation: 3, isCurrent: () => false });
    assert.equal(stale.status, 'stale');
    const oversize = await runtime.renderMermaid({ source: mermaidFixtures.oversizeSource(), resolvedTheme: 'light', generation: 4 });
    assert.equal(oversize.status, 'oversize');
    assert.equal(calls.length, 2);
});
