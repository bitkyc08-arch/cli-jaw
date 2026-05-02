import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeDomForHash,
    domHashAround,
    selectorMatchSummary,
} from '../../src/browser/web-ai/dom-hash.js';

test('DH-001: normalizeDomForHash strips comments, attributes, and text', () => {
    const html = '<div class="foo">hello <span>world</span></div>';
    const normalized = normalizeDomForHash(html);
    assert.equal(normalized, '<div><span></span></div>');
});

test('DH-002: normalizeDomForHash handles comments', () => {
    const html = '<div><!-- comment -->text</div>';
    const normalized = normalizeDomForHash(html);
    assert.equal(normalized, '<div></div>');
});

test('DH-003: domHashAround returns hash when selector matches', async () => {
    const page = {
        evaluate: async () => '<div>mock html</div>',
    };
    const hash = await domHashAround(page as any, ['body']);
    assert.ok(hash);
    assert.ok(hash?.startsWith('sha256:'));
});

test('DH-004: domHashAround returns null when no selector matches', async () => {
    const page = {
        evaluate: async () => null,
    };
    const hash = await domHashAround(page as any, ['#nonexistent']);
    assert.equal(hash, null);
});

test('DH-005: selectorMatchSummary counts matched and visible locators', async () => {
    const page = {
        locator: (selector: string) => ({
            count: async () => (selector === '.match' ? 2 : 0),
            nth: (index: number) => ({
                isVisible: async () => selector === '.match' && index === 0,
            }),
        }),
    };
    const summary = await selectorMatchSummary(page as any, ['.match', '.none']);
    assert.equal(summary.length, 2);
    assert.equal(summary[0].matched, 2);
    assert.equal(summary[0].visible, true);
    assert.equal(summary[1].matched, 0);
    assert.equal(summary[1].visible, false);
});
