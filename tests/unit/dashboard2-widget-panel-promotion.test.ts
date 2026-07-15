import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement as h } from 'react';
import * as ReactNamespace from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ManagerPreferencesProvider, type PreferencesRegistryClient } from '../../public/dashboard2/src/providers/preferences-provider.tsx';
import { WidgetSegment } from '../../public/dashboard2/src/turn-stream/components/segments/WidgetSegment.tsx';
import {
    createWidgetPanelPayload,
    widgetPanelKey,
} from '../../public/dashboard2/src/turn-stream/widgets/widget-panel-key.ts';
import { createWidgetUiStore } from '../../public/dashboard2/src/turn-stream/widgets/widget-ui-store.ts';

(globalThis as Record<string, unknown>).React = ReactNamespace;

const prefsClient: PreferencesRegistryClient = {
    async load() {
        return { registry: { ui: { uiTheme: 'auto', locale: 'en', dashboardShortcutsEnabled: true, dashboardShortcutKeymap: 'default' } } as never, status: {} };
    },
    async patch() {
        return { registry: { ui: { uiTheme: 'auto', locale: 'en', dashboardShortcutsEnabled: true, dashboardShortcutKeymap: 'default' } } as never, status: {} };
    },
};

const descriptor = {
    widgetId: 'shared/widget',
    title: 'Shared widget',
    estimatedHeight: 240,
    storage: 'file' as const,
    revision: 'r1',
    capabilities: ['interactive', 'stateful'] as const,
};

function identity(turnId: string) {
    return { scopeKey: '3457/session-1', turnId, segmentId: 'widget-segment' };
}

test('canonical panel key is shared across turns while row keys stay separate', () => {
    const first = createWidgetPanelPayload('turn-widget', 'session-1', descriptor, identity('turn-1'));
    const second = createWidgetPanelPayload('turn-widget', 'session-1', descriptor, identity('turn-2'));
    assert.ok(first && second);
    assert.equal(first.panelKey, second.panelKey);
    assert.notEqual(first.rowKey, second.rowKey);
    assert.notEqual(widgetPanelKey('a:b', 'c'), widgetPanelKey('a', 'b:c'), 'encoded key parts must not collide');
    const store = createWidgetUiStore();
    store.collapse(first.panelKey, first.rowKey, 'turn-1-latch');
    assert.equal(store.isManuallyCollapsed(first.rowKey, 'turn-1-latch'), true);
    assert.equal(store.isManuallyCollapsed(second.rowKey, 'turn-1-latch'), false, 'row latches must not share the panel key');
});

test('promotion follows queued → dispatched → mounting → panel and close restores every row', () => {
    const first = createWidgetPanelPayload('turn-widget', 'session-1', descriptor, identity('turn-1'))!;
    const second = createWidgetPanelPayload('turn-widget', 'session-1', descriptor, identity('turn-2'))!;
    const store = createWidgetUiStore();

    store.requestPromotion(first, 'inline');
    assert.equal(store.getSnapshot()[first.panelKey]?.mode, 'inline', 'open request must not pre-bind panel mode');
    assert.equal(store.getSnapshot()[first.panelKey]?.handoff, 'queued');
    store.markPromotionDispatched(first.panelKey);
    assert.equal(store.getSnapshot()[first.panelKey]?.handoff, 'dispatched');
    store.reconcilePanelInstances(new Set([first.panelKey]), null);
    assert.equal(store.getSnapshot()[first.panelKey]?.handoff, 'mounting', 'inline owner is released before panel commit');
    assert.equal(store.getSnapshot()[first.panelKey]?.mode, 'inline');
    store.promote(first.panelKey);
    assert.equal(store.getSnapshot()[first.panelKey]?.mode, 'panel');

    assert.equal(store.getSnapshot()[second.panelKey]?.mode, 'panel', 'a later turn reads the same canonical owner');
    store.reconcilePanelInstances(new Set(), null);
    assert.equal(store.getSnapshot()[first.panelKey]?.mode, 'inline');
    assert.equal(store.getSnapshot()[second.panelKey]?.mode, 'inline', 'one close releases all rows for the widget');
});

test('closing a promoted placeholder still returns every row to inline mode', () => {
    const payload = createWidgetPanelPayload('turn-widget', 'session-1', descriptor, identity('turn-placeholder'))!;
    const store = createWidgetUiStore();
    store.requestPromotion(payload, 'placeholder');
    store.markPromotionDispatched(payload.panelKey);
    store.reconcilePanelInstances(new Set([payload.panelKey]), null);
    store.promote(payload.panelKey);
    store.reconcilePanelInstances(new Set(), null);
    assert.equal(store.getSnapshot()[payload.panelKey]?.mode, 'inline');
});

test('panel-limit rejection cancels handoff without hiding the inline widget', () => {
    const payload = createWidgetPanelPayload('turn-widget', 'session-1', descriptor, identity('turn-limit'))!;
    const store = createWidgetUiStore();
    store.requestPromotion(payload, 'inline');
    store.markPromotionDispatched(payload.panelKey);
    store.reconcilePanelInstances(new Set(), 'Side pane limit reached (8).');
    assert.equal(store.getSnapshot()[payload.panelKey]?.mode, 'inline');
    assert.equal(store.getSnapshot()[payload.panelKey]?.handoff, 'idle');
    assert.equal(store.getSnapshot()[payload.panelKey]?.request, null);
});

test('promotion action is hard-gated to direct turn widgets', () => {
    const base = { descriptor, expanded: false, onToggle() {}, chatId: 'session-1', identity: identity('turn-render') };
    const render = (element: ReturnType<typeof h>) => renderToStaticMarkup(h(ManagerPreferencesProvider, { client: prefsClient }, element));
    assert.doesNotMatch(render(h(WidgetSegment, base)), /위젯을 패널로 열기/);
    assert.match(render(h(WidgetSegment, { ...base, promotionSource: 'turn-widget' })), /위젯을 패널로 열기/);
    assert.doesNotMatch(render(h(WidgetSegment, {
        ...base,
        promotionSource: 'turn-widget',
        descriptor: { ...descriptor, capabilities: ['interactive'] },
    })), /위젯을 패널로 열기/);

    const markdownSource = readFileSync(new URL('../../public/dashboard2/src/turn-stream/components/MarkdownSegment.tsx', import.meta.url), 'utf8');
    assert.doesNotMatch(markdownSource, /promotionSource/, 'scopeKey-as-chatId markdown widgets stay deferred');
});

test('only audited direct producers opt into panel promotion', () => {
    const turnRow = readFileSync(new URL('../../public/dashboard2/src/turn-stream/components/TurnRow.tsx', import.meta.url), 'utf8');
    const liveTail = readFileSync(new URL('../../public/dashboard2/src/turn-stream/live/LiveTurnTail.tsx', import.meta.url), 'utf8');
    assert.match(turnRow, /promotionSource="turn-widget"/);
    assert.match(liveTail, /promotionSource="turn-widget"/);
});
