import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { TurnSegment } from '../../src/shared/chat-events.ts';
import { adaptWidgetSegment, normalizeWidgetSlot } from '../../public/dashboard2/src/turn-stream/widgets/widget-segment-adapter.ts';
import { buildWidgetSrcdoc, createWidgetIframeBridge } from '../../public/dashboard2/src/turn-stream/widgets/widget-iframe-bridge.ts';
import { createWidgetSourceClient, WidgetSourceError } from '../../public/dashboard2/src/turn-stream/widgets/widget-source-client.ts';
import { createWidgetUiStore } from '../../public/dashboard2/src/turn-stream/widgets/widget-ui-store.ts';

const segment = (segmentId: string): TurnSegment => ({ turnId: 't', turnSeq: 1, segmentId, sessionId: 's', createdAt: 1, observedAt: 1, providerAt: null, fidelity: 'full', thinkingMarker: null, type: 'widget', status: 'running', detailRef: null });

test('adapter decodes durable descriptors, normalizes manifest widgets, rejects mermaid, and never infers capabilities', () => {
    const encoded = Buffer.from(JSON.stringify({ widgetId: 'file', storage: 'file', revision: 'r1', title: 'F', estimatedHeight: 200 })).toString('base64url');
    assert.deepEqual(adaptWidgetSegment(segment(`widget:${encoded}`))?.descriptor.capabilities, []);
    assert.deepEqual(normalizeWidgetSlot({ kind: 'widget', storage: 'inline', source: 'PHA+eDwvcD4=', revision: 'r2' })?.capabilities, []);
    assert.equal(normalizeWidgetSlot({ kind: 'mermaid', source: 'graph TD' }), null);
    assert.equal(adaptWidgetSegment(segment('x'), { kind: 'mermaid' }), null);
});

test('widget UI store keeps a serializable manual-collapse revision latch', () => {
    const store = createWidgetUiStore();
    store.expand('w');
    assert.equal(store.getSnapshot()['w']?.mode, 'inline');
    store.collapse('w', 't|s|r1');
    assert.equal(store.isManuallyCollapsed('w', 't|s|r1'), true);
    assert.doesNotThrow(() => JSON.stringify(store.getSnapshot()));
});

test('source client uses explicit chatId and cancellation generations', async () => {
    let requested = '';
    const client = createWidgetSourceClient(async input => { requested = String(input); return new Response('<p>ok</p>'); });
    const result = await client.load({ chatId: 'chat explicit', storage: 'file', widgetId: 'w.html', revision: 'r' });
    assert.equal(requested, '/api/widgets/chat%20explicit/w.html');
    assert.equal(result.source, '<p>ok</p>');
    const pending = createWidgetSourceClient((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    const promise = pending.load({ chatId: 'c', storage: 'file', widgetId: 'w', revision: 'r' });
    pending.cancel();
    await assert.rejects(promise, (error: unknown) => error instanceof WidgetSourceError && error.code === 'cancelled');
});

test('bridge emits CSP, allow-scripts-only iframe, validates source/origin/nonce, and tears down', () => {
    const dom = new JSDOM('<div></div>', { url: 'https://host.test' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    const srcdoc = buildWidgetSrcdoc('<p>safe</p>', 'nonce');
    assert.match(srcdoc, /Content-Security-Policy/);
    const bridge = createWidgetIframeBridge(dom.window as unknown as Window);
    let resized = 0;
    const runtime = bridge.create('<p>safe</p>', { onResize: height => { resized = height; } });
    assert.equal(runtime.iframe.getAttribute('sandbox'), 'allow-scripts');
    dom.window.document.body.append(runtime.iframe);
    runtime.iframe.dispatchEvent(new dom.window.Event('load'));
    const source = runtime.iframe.contentWindow;
    const message = (origin: string, nonce: string) => {
        const event = new dom.window.MessageEvent('message', { data: { type: 'jaw-diagram-resize', nonce, height: 400 } });
        Object.defineProperties(event, { origin: { value: origin }, source: { value: source } });
        dom.window.dispatchEvent(event);
    };
    message('https://bad', runtime.nonce);
    message('null', 'bad');
    assert.equal(resized, 0);
    message('null', runtime.nonce);
    assert.equal(resized, 400);
    assert.equal(bridge.size(), 1);
    bridge.destroy(runtime); bridge.dispose();
    assert.equal(bridge.size(), 0);
});
