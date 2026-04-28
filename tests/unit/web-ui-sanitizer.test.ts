import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

test.afterEach(() => {
    resetWebUiDom();
});

test('renderMarkdown strips scripts and event handlers', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');

    const html = renderMarkdown('<img src=x onerror=alert(1)><script>alert(1)</script>');

    assert.doesNotMatch(html, /onerror/i);
    assert.doesNotMatch(html, /<script/i);
});

test('sanitizer strips external SVG hrefs and preserves fragment hrefs', async () => {
    setupWebUiDom();
    const { sanitizeHtml } = await import('../../public/js/render.ts');

    const html = sanitizeHtml('<svg><use href="https://evil.example/x"></use><use href="#local"></use></svg>');

    assert.doesNotMatch(html, /https:\/\/evil\.example/);
    assert.match(html, /#local/);
});
