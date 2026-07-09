import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

test.afterEach(() => {
    resetWebUiDom();
});

// Single test: the delegation ready-flag is module-level, so the listener binds
// to the document alive at first renderMarkdown() — same as the real app, where
// one document lives for the whole session.
test('capture delegation replaces current and late inline-image failures', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');

    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('![Preview](https://example.invalid/missing.png)');
    document.body.appendChild(host);
    const image = host.querySelector('.chat-inline-img');
    assert.ok(image, 'renderer must emit .chat-inline-img');

    // 'error' does not bubble — only a capture-phase document listener sees it.
    image!.dispatchEvent(new window.Event('error', { bubbles: false }));
    const firstError = host.querySelector('.chat-inline-img-error');
    assert.equal(firstError?.textContent, 'Image unavailable: Preview');
    assert.equal(host.querySelector('.chat-inline-img'), null, 'failed img must be replaced');

    // Late node (virtual-scroll/lazy hydrate path): delegation must cover
    // elements appended after setup without any per-node wiring.
    const lateImage = document.createElement('img');
    lateImage.className = 'chat-inline-img';
    lateImage.alt = 'Lazy history';
    host.appendChild(lateImage);
    lateImage.dispatchEvent(new window.Event('error', { bubbles: false }));
    assert.equal(host.querySelectorAll('.chat-inline-img-error').length, 2);
    assert.equal(
        host.querySelectorAll('.chat-inline-img-error')[1]?.textContent,
        'Image unavailable: Lazy history',
    );

    // Lightbox regression: the replacement is a <div> without .chat-inline-img,
    // so the lightbox click delegation selector cannot match it.
    const placeholder = host.querySelector<HTMLElement>('.chat-inline-img-error');
    assert.equal(placeholder!.tagName, 'DIV');
    assert.equal(placeholder!.classList.contains('chat-inline-img'), false);
    assert.equal(placeholder!.getAttribute('role'), 'status');
});
