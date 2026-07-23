import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement as h } from 'react';
import * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import {
    AppScopeProvider,
    useAppScope,
    type AppScopeValue,
} from '../../public/dashboard2/src/state/scope.tsx';

(globalThis as Record<string, unknown>).React = ReactNamespace;

const STORAGE_KEY = 'd2.sidepane.v1';

function installDom(): JSDOM {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://dashboard.test/dashboard2/' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    return dom;
}

async function mountScope(dom: JSDOM): Promise<{ getScope(): AppScopeValue; root: Root }> {
    let scope: AppScopeValue | null = null;
    function Probe() { scope = useAppScope(); return null; }
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root.render(h(AppScopeProvider, null, h(Probe))));
    return {
        getScope() {
            assert.ok(scope);
            return scope;
        },
        root,
    };
}

async function remountScope(dom: JSDOM, root: Root): Promise<{ getScope(): AppScopeValue; root: Root }> {
    await act(async () => root.unmount());
    dom.window.document.body.innerHTML = '<div id="root"></div>';
    return mountScope(dom);
}

test('075 saves metadata only and restores restorable instances after reload', async () => {
    const dom = installDom();
    let mounted = await mountScope(dom);
    await act(async () => {
        mounted.getScope().openPanel({
            type: 'terminal',
            key: 'shell:1',
            title: 'Shell 1',
            payload: { transcript: 'never persist me' },
            keepAlive: true,
        });
        mounted.getScope().openPanel({
            type: 'doc',
            key: '/private.md',
            title: 'Private document',
            payload: { content: 'secret body' },
        });
    });

    const persisted = JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
    assert.deepEqual(persisted, {
        v: 1,
        instances: [
            { type: 'terminal', key: 'shell:1', title: 'Shell 1', keepAlive: true, ordinal: 1 },
            { type: 'doc', key: '/private.md', title: 'Private document', keepAlive: false, ordinal: 2 },
        ],
        activePanelId: 'side-panel-2',
    });
    assert.equal(JSON.stringify(persisted).includes('payload'), false);
    assert.equal(JSON.stringify(persisted).includes('secret body'), false);

    mounted = await remountScope(dom, mounted.root);
    assert.deepEqual(mounted.getScope().panelInstances.map((panel) => ({
        id: panel.id,
        type: panel.type,
        payload: panel.payload,
        ordinal: panel.ordinal,
    })), [{ id: 'side-panel-1', type: 'terminal', payload: null, ordinal: 1 }]);
    assert.equal(mounted.getScope().activePanelId, 'side-panel-1', 'non-restored active doc falls back to first instance');
    assert.equal(mounted.getScope().nextPanelOrdinal, 2, 'ordinal recomputes from restored instances only');
    await act(async () => mounted.root.unmount());
});

test('075 malformed JSON silently restores defaults', async () => {
    const dom = installDom();
    dom.window.localStorage.setItem(STORAGE_KEY, '{not-json');
    const mounted = await mountScope(dom);
    assert.deepEqual(mounted.getScope().panelInstances, []);
    assert.equal(mounted.getScope().activePanelId, null);
    assert.equal(mounted.getScope().nextPanelOrdinal, 1);
    await act(async () => mounted.root.unmount());
});

test('075 restore excludes non-restorable types and recomputes max ordinal plus stale active fallback', async () => {
    const dom = installDom();
    dom.window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: 1,
        instances: [
            { type: 'board', key: 'board', title: 'Board', keepAlive: true, ordinal: 4 },
            { type: 'doc', key: '/a.md', title: 'Doc', keepAlive: false, ordinal: 5 },
            { type: 'widget', key: 'inline-secret', title: 'Widget', keepAlive: false, ordinal: 6 },
            { type: 'browser', key: 'browser:2', title: 'Browser', keepAlive: true, ordinal: 9 },
        ],
        activePanelId: 'side-panel-999',
    }));
    const mounted = await mountScope(dom);
    assert.deepEqual(mounted.getScope().panelInstances.map((panel) => panel.type), ['board', 'browser']);
    assert.equal(mounted.getScope().activePanelId, 'side-panel-4');
    assert.equal(mounted.getScope().nextPanelOrdinal, 10);
    await act(async () => mounted.root.unmount());
});

test('075 quota failure preserves in-memory state without crashing', async () => {
    const dom = installDom();
    const storage = dom.window.localStorage;
    const prototype = Object.getPrototypeOf(storage) as Storage;
    const originalSetItem = prototype.setItem;
    prototype.setItem = () => { throw new dom.window.DOMException('Quota exceeded', 'QuotaExceededError'); };
    try {
        const mounted = await mountScope(dom);
        await act(async () => {
            mounted.getScope().openPanel({ type: 'notes', key: 'notes', title: 'Notes', keepAlive: true });
        });
        assert.equal(mounted.getScope().panelInstances.length, 1);
        assert.equal(mounted.getScope().panelInstances[0]?.type, 'notes');
        assert.equal(mounted.getScope().activePanelId, 'side-panel-1');
        await act(async () => mounted.root.unmount());
    } finally {
        prototype.setItem = originalSetItem;
    }
});
