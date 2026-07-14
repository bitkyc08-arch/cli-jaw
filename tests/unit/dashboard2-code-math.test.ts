import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { codeMathFixtures as fixture } from '../fixtures/dashboard2/render-parity/code-math.js';
import { approvedGrammarInventory, isApprovedLanguage, normalizeLanguage, type CodeBlockModel, type HighlightRequest } from '../../public/dashboard2/src/turn-stream/render/code-block-contract.js';
import { HighlightService, highlightWithRuntime, routeHighlightRequest } from '../../public/dashboard2/src/turn-stream/render/highlight-service.js';
import { extractMarkdownSlots } from '../../public/dashboard2/src/turn-stream/render/markdown-slot-manifest.js';
import { getRenderCache, grammarBundle, highlightCacheKey, shikiVersion, transformerVersion } from '../../public/dashboard2/src/turn-stream/render/render-cache.js';
import { isValidKatexStyle, sanitizeHtml } from '../../public/dashboard2/src/turn-stream/render/sanitize-policy.js';
import { renderMathSlot } from '../../public/dashboard2/src/turn-stream/render/katex-hydrator.js';

const request = (code: string, overrides: Partial<HighlightRequest> = {}): HighlightRequest => ({
    code, codeHash: 'hash', language: 'ts', streaming: false, openFence: false,
    generation: 1, priority: 'visible', ...overrides,
});

test('code routing honors exact byte boundaries and inert states', () => {
    assert.equal(routeHighlightRequest(request(fixture.code8192)), 'main');
    assert.equal(routeHighlightRequest(request(fixture.code8193)), 'worker');
    assert.equal(routeHighlightRequest(request(fixture.code204800)), 'worker');
    assert.equal(routeHighlightRequest(request(fixture.code204801)), 'manual');
    assert.equal(routeHighlightRequest(request('x', { streaming: true })), 'plain');
    assert.equal(routeHighlightRequest(request('x', { openFence: true })), 'plain');
    assert.equal(routeHighlightRequest(request(fixture.code204801, { priority: 'manual' })), 'worker');
    assert.equal(routeHighlightRequest(request('x'.repeat(1024 * 1024 + 1), { priority: 'manual' })), 'reject');
});

test('aliases canonicalize and unknown languages stay plain without detection', () => {
    assert.deepEqual(fixture.aliases.map(normalizeLanguage), ['javascript', 'typescript', 'python', 'bash', 'yaml', 'rust', 'cpp', 'plaintext', 'plaintext']);
    assert.equal(isApprovedLanguage(normalizeLanguage(fixture.unknownLanguage)), false);
    assert.equal(routeHighlightRequest(request('const x=1', { language: fixture.unknownLanguage })), 'plain');
    assert.equal(approvedGrammarInventory.length, 18);
});

test('highlight cache key is exact and theme-independent', () => {
    const expected = `abc:typescript:${shikiVersion}:${grammarBundle}:${transformerVersion}`;
    assert.equal(highlightCacheKey('abc', 'typescript'), expected);
    assert.equal(highlightCacheKey('abc', 'typescript'), expected, 'theme toggle has no key input');
});

test('cancelled generation cannot commit a late highlight to cache', async () => {
    const service = new HighlightService();
    const pending = request('const stale = true'.padEnd(8193, ' '), { language: 'ts', generation: 1 });
    const key = highlightCacheKey(pending.codeHash, 'typescript');
    const handle = service.request('generation-test', pending); handle.cancel();
    await handle.promise; await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(getRenderCache().get('highlight', key), undefined);
});

test('slot manifest extracts code and math with stable math ordinals', () => {
    const source = `${fixture.comments}\n${fixture.math}`;
    const final = extractMarkdownSlots(source, 'nonce', true);
    assert.equal(final.slots.filter(slot => slot.kind === 'code').length, 1);
    assert.deepEqual(final.slots.filter(slot => slot.kind === 'math').map(slot => slot.ordinal), [0, 1, 2, 3]);
    for (let cut = 0; cut <= source.length; cut += 17) assert.doesNotThrow(() => extractMarkdownSlots(source.slice(0, cut), 'nonce', false));
    assert.equal(extractMarkdownSlots(fixture.openFence, 'nonce', false).slots.length, 0);
    assert.equal(extractMarkdownSlots(fixture.openFence, 'nonce', true).slots[0]?.kind, 'code');
});

test('KaTeX style validator accepts layout only and sanitizer rejects active/color styles', () => {
    assert.equal(isValidKatexStyle('top:-0.2em;margin-left:0.1em;width:calc(1em + 2px)'), true);
    for (const style of ['color:red', 'background:url(x)', 'width:expression(x)', 'font-family:x']) assert.equal(isValidKatexStyle(style), false);
    const dom = new JSDOM('<!doctype html>'); Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    const clean = sanitizeHtml('<span class="katex"><span style="top:-0.2em;color:red;width:1em">x</span></span>', 'katex');
    assert.doesNotMatch(clean, /style=/, 'mixed declarations fail closed');
    delete (globalThis as { window?: unknown }).window;
});

test('math cap accepts 32 KiB and preserves source on oversize/malformed input', async () => {
    const slot = (tex: string) => ({ id: 'm', kind: 'math' as const, tex, displayMode: false, ordinal: 0 });
    assert.notEqual((await renderMathSlot(slot(fixture.tex32768), 'en')).kind, 'oversize');
    const oversized = await renderMathSlot(slot(fixture.tex32769), 'en');
    assert.equal(oversized.kind, 'oversize'); if (oversized.kind === 'oversize') assert.equal(oversized.source, fixture.tex32769);
    const malformed = await renderMathSlot(slot('\\frac{'), 'en');
    assert.equal(malformed.kind, 'error'); if (malformed.kind === 'error') assert.equal(malformed.source, '\\frac{');
});

test('real Shiki smoke emits bounded semantic classes and no inline colors', async () => {
    const dom = new JSDOM('<!doctype html>'); Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    const html = await highlightWithRuntime('const answer: number = 42', 'typescript');
    assert.match(html, /token syntax-/); assert.doesNotMatch(html, /style=|#[0-9a-f]{3,8}|rgb\(/i);
    delete (globalThis as { window?: unknown }).window;
});

test('071 Notes and 084 detail adapters compile against presentation-neutral contracts', () => {
    const notesRequest: HighlightRequest = request('note');
    const detailRequest: HighlightRequest = { ...notesRequest, code: 'visible lines', priority: 'prewarm' };
    const model: CodeBlockModel = { source: notesRequest.code, language: 'typescript', openFence: false, streaming: false, wrap: 'nowrap', copy: 'idle', ui: { kind: 'plain' } };
    assert.equal(detailRequest.priority, 'prewarm'); assert.equal(model.ui.kind, 'plain');
});
