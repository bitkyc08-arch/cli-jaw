import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const iframeSrc = readFileSync(
    join(import.meta.dirname, '../../public/js/diagram/iframe-renderer.ts'),
    'utf8',
);

const cssSrc = readFileSync(
    join(import.meta.dirname, '../../public/css/diagram.css'),
    'utf8',
);

test('diagram-html widgets create zoom, save, and copy controls', () => {
    assert.ok(iframeSrc.includes('function createDiagramZoomBtn()'),
        'iframe renderer must define a widget zoom button helper');
    assert.ok(iframeSrc.includes("wrapper.appendChild(createDiagramZoomBtn())"),
        'initial widget activation must append zoom before iframe');
    assert.ok(iframeSrc.includes('bindWidgetZoom(wrapper)'),
        'initial widget activation must bind widget-specific zoom handling');
    assert.ok(iframeSrc.includes('container.appendChild(createDiagramZoomBtn())'),
        'theme reload must restore the widget zoom button');
    assert.ok(iframeSrc.includes('bindWidgetZoom(container as HTMLElement)'),
        'theme reload must re-bind widget-specific zoom handling');
});

test('diagram-html widget overlay recreates iframe from encoded source', () => {
    const idx = iframeSrc.indexOf('function openWidgetOverlay');
    assert.ok(idx >= 0, 'openWidgetOverlay must exist');
    const block = iframeSrc.slice(idx, idx + 3400);

    assert.ok(block.includes('decodeWidgetHtml(encoded)'),
        'overlay must decode the stored widget source');
    assert.ok(block.includes('validateWidgetHtml(htmlCode)'),
        'overlay must validate source before iframe creation');
    assert.ok(block.includes('createWidgetIframe(htmlCode)'),
        'overlay must create a fresh sandboxed iframe');
    assert.ok(block.includes('attachWidgetIframeLifecycle({ iframe, nonce, owner: content })'),
        'overlay iframe must use the shared lifecycle helper');
    assert.ok(!block.includes('sanitizeHtml'),
        'widget overlay must not use the SVG/html sanitizer path that strips iframe');
});

test('diagram-html widget lifecycle is shared across activation, theme reload, and overlay', () => {
    assert.ok(iframeSrc.includes('function attachWidgetIframeLifecycle'),
        'shared iframe lifecycle helper must exist');
    assert.ok(iframeSrc.includes('widgetLifecycleCleanups'),
        'lifecycle helper must retain cleanup callbacks');
    assert.ok(iframeSrc.includes('revokeIframeTrust(input.iframe)'),
        'lifecycle helper must revoke postMessage trust on cleanup/navigation/timeout');
    assert.ok(iframeSrc.match(/attachWidgetIframeLifecycle\(\{/g)?.length! >= 3,
        'activation, theme reload, and overlay should all use the lifecycle helper');
});

test('diagram-html overlay supports reversible expand and shrink', () => {
    const idx = iframeSrc.indexOf('function openWidgetOverlay');
    const block = iframeSrc.slice(idx, idx + 3200);

    assert.ok(block.includes('createDiagramSizeToggleBtn()'),
        'overlay must create an internal size toggle button');
    assert.ok(block.includes("overlay.classList.toggle('maximized')"),
        'size button must toggle maximized state');
    assert.ok(block.includes("sizeBtn.title = maximized ? 'Shrink' : 'Expand'"),
        'size button title must switch between shrink and expand');
    assert.ok(block.includes("sizeBtn.ariaLabel = maximized ? 'Shrink diagram' : 'Expand diagram'"),
        'size button aria-label must switch between shrink and expand');

    assert.ok(cssSrc.includes('.diagram-widget-overlay.maximized .diagram-overlay-content'),
        'CSS must define maximized overlay sizing');
    assert.ok(cssSrc.includes('.diagram-size-toggle-btn'),
        'CSS must style the overlay size toggle button');
});
