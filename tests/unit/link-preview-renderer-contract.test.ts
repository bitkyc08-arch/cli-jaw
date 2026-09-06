import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

function read(path: string): string {
    return readFileSync(join(import.meta.dirname, '../..', path), 'utf8');
}

const postRenderSrc = read('public/js/render/post-render.ts');

test.afterEach(() => {
    resetWebUiDom();
});

test('link preview hydrates external links through metadata and image proxy routes', async () => {
    setupWebUiDom();
    const calls: string[] = [];
    Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: async (url: string) => {
            calls.push(url);
            return new Response(JSON.stringify({
                ok: true,
                data: {
                    title: 'Example title',
                    description: 'Example description',
                    siteName: 'Example',
                    domain: 'example.com',
                    finalUrl: 'https://example.com/post',
                    image: 'https://cdn.example.com/preview.jpg',
                    favicon: 'https://example.com/favicon.ico',
                },
            }), { headers: { 'content-type': 'application/json' } });
        },
    });
    const { hydrateLinkPreviewCards } = await import('../../public/js/render/link-preview.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<a href="https://example.com/post">https://example.com/post</a>';
    document.body.appendChild(wrapper);

    hydrateLinkPreviewCards(wrapper);
    await new Promise(resolve => setTimeout(resolve, 0));

    const card = wrapper.querySelector<HTMLAnchorElement>('.link-preview-card');
    assert.ok(card);
    assert.match(card.textContent || '', /Example title/);
    assert.match(card.innerHTML, /\/api\/link-preview\/image\?url=/);
    assert.ok(calls.some(call => call.includes('/api/link-preview?url=')));
});

test('link preview skips same-origin, private, media, and already attached links', async () => {
    setupWebUiDom();
    let calls = 0;
    Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: async () => {
            calls += 1;
            return new Response('', { status: 204 });
        },
    });
    const { hydrateLinkPreviewCards } = await import('../../public/js/render/link-preview.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
        <a href="http://127.0.0.1/private">local</a>
        <a href="/api/settings">internal</a>
        <a href="https://example.com/image.png">media</a>
        <a href="https://example.com/attached" data-link-preview-attached="true">attached</a>`;
    document.body.appendChild(wrapper);

    hydrateLinkPreviewCards(wrapper);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(calls, 0);
    assert.equal(wrapper.querySelectorAll('.link-preview-card').length, 0);
});

// Live/fresh-VS and lazy history hydration, scoped counts and recycling are exercised
// through real entrypoints in web-structured-hydration.test.ts.
test('link preview remains included in scheduled finalization', () => {
    assert.match(postRenderSrc, /hydrateLinkPreviewCards\(msgContainer\)/);
});
