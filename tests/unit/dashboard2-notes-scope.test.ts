import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { act, createElement as h, useEffect } from 'react';
import * as ReactNamespace from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import {
    AppScopeProvider,
    useAppScope,
    type AppScopeValue,
} from '../../public/dashboard2/src/state/scope.tsx';
import { normalizeNotesPath } from '../../public/dashboard2/src/features/notes/notes-open-intent.ts';

(globalThis as Record<string, unknown>).React = ReactNamespace;

function installDom(): JSDOM {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://dashboard.test/dashboard2/' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    return dom;
}

test('071 notes path normalization rejects blanks/outside roots and normalizes contained markdown', () => {
    assert.equal(normalizeNotesPath('   ', '/vault/notes'), null);
    assert.equal(normalizeNotesPath('/outside/plan.md', '/vault/notes'), null);
    assert.equal(normalizeNotesPath('/vault/notes/projects/plan.md', '/vault/notes'), 'projects/plan.md');
    assert.equal(normalizeNotesPath('/vault/notes/projects/../secret.md', '/vault/notes'), null);
    assert.equal(normalizeNotesPath('/vault/notes/.git/secret.md', '/vault/notes'), null);
    assert.equal(normalizeNotesPath('/vault/notes/projects/plan.txt', '/vault/notes'), null);
    assert.equal(normalizeNotesPath('C:\\Users\\Jun\\notes\\daily\\today.md', 'C:\\Users\\Jun\\notes'), 'daily/today.md');
    assert.equal(normalizeNotesPath('C:\\Users\\Jun\\other\\today.md', 'C:\\Users\\Jun\\notes'), null);
});

test('071 guarded transitions block cancellation, advance approval, and use sync dirty snapshot for beforeunload', async () => {
    const dom = installDom();
    let scope: AppScopeValue | null = null;
    function Probe() { scope = useAppScope(); return null; }
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root.render(h(AppScopeProvider, null, h(Probe))));

    let allow = false;
    let guardCalls = 0;
    await act(async () => {
        scope!.registerLeaveGuard('test', () => { guardCalls += 1; return allow; });
        scope!.registerDirtyCheck('test', () => true);
    });
    assert.equal(await scope!.guardedSelectSession(3457, 'blocked'), false);
    assert.equal(scope!.selected, null);
    allow = true;
    await act(async () => { assert.equal(await scope!.guardedSelectSession(3457, 'approved'), true); });
    assert.deepEqual(scope!.selected, { port: 3457, sessionId: 'approved' });
    assert.equal(guardCalls, 2);

    await act(async () => {
        scope!.openSidePane();
        scope!.openPanel({ type: 'notes', key: 'notes', title: 'Notes' });
        scope!.openPanel({ type: 'board', key: 'board', title: 'Board' });
    });
    const notesId = scope!.panelInstances.find(panel => panel.type === 'notes')!.id;
    const boardId = scope!.panelInstances.find(panel => panel.type === 'board')!.id;
    allow = false;
    assert.equal(await scope!.guardedActivatePanel(notesId), false);
    assert.equal(await scope!.guardedClosePanel(boardId), false);
    assert.equal(await scope!.guardedCloseSidePane(), false);
    assert.equal(await scope!.guardedSetWorkspaceMode('settings'), false);
    assert.equal(scope!.activePanelId, boardId);
    assert.equal(scope!.sidePaneOpen, true);
    assert.equal(scope!.workspaceMode, 'chat');
    allow = true;
    await act(async () => { assert.equal(await scope!.guardedActivatePanel(notesId), true); });
    await act(async () => { assert.equal(await scope!.guardedSetWorkspaceMode('settings'), true); });
    await act(async () => { assert.equal(await scope!.guardedCloseSidePane(), true); });
    await act(async () => { assert.equal(await scope!.guardedCloseActivePanel(), true); });
    await act(async () => { assert.equal(await scope!.guardedClosePanel(boardId), true); });
    assert.equal(scope!.panelInstances.length, 0);

    const event = new dom.window.Event('beforeunload', { cancelable: true });
    dom.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await act(async () => root.unmount());
});

test('071 pending notes intent survives lazy mount and is consumed by matching sequence only', async () => {
    const dom = installDom();
    let fetchCalls = 0;
    Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify({ root: '/vault/notes' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
            });
        },
    });
    let scope: AppScopeValue | null = null;
    let mountConsumer = false;
    function Consumer({ consume }: { consume: boolean }) {
        const current = useAppScope();
        scope = current;
        useEffect(() => {
            if (consume && current.pendingNotesIntent) current.consumeNotesIntent(current.pendingNotesIntent.seq);
        }, [consume, current.consumeNotesIntent, current.pendingNotesIntent]);
        return null;
    }
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root.render(h(AppScopeProvider, null, h(Consumer, { consume: mountConsumer }))));
    assert.equal(await scope!.openNotesAt('  '), false);
    assert.equal(scope!.pendingNotesIntent, null);
    assert.equal(fetchCalls, 0, 'blank paths are a true no-op');
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        assert.equal(await scope!.openNotesAt('/outside/nope.md'), false);
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(scope!.pendingNotesIntent, null);
    assert.equal(warnings.length, 1, 'outside-root absolute path warns once');
    await act(async () => { assert.equal(await scope!.openNotesAt('/vault/notes/daily/today.md'), true); });
    assert.deepEqual(scope!.pendingNotesIntent, { path: 'daily/today.md', seq: 1 });
    assert.equal(scope!.panelInstances[0]?.type, 'notes');

    mountConsumer = true;
    await act(async () => root.render(h(AppScopeProvider, null, h(Consumer, { consume: mountConsumer }))));
    assert.equal(scope!.pendingNotesIntent, null);
    await act(async () => root.unmount());
});

test('071 guarded raw actions are absent from the public scope and all named callers use wrappers', () => {
    const scopeSource = readFileSync('public/dashboard2/src/state/scope.tsx', 'utf8');
    const sidebar = readFileSync('public/dashboard2/src/shell/Sidebar.tsx', 'utf8');
    const workbench = readFileSync('public/dashboard2/src/shell/Workbench.tsx', 'utf8');
    const sidePane = readFileSync('public/dashboard2/src/shell/SidePane.tsx', 'utf8');
    const settings = readFileSync('public/dashboard2/src/features/settings/SettingsWorkspace.tsx', 'utf8');
    const publicInterface = scopeSource.slice(scopeSource.indexOf('export interface AppScopeValue'), scopeSource.indexOf('export type AppScopeAction'));
    assert.doesNotMatch(publicInterface, /\b(?:selectSession|closeSidePane|activatePanel|closePanel|closeActivePanel|setWorkspaceMode)\s*\(/);
    assert.match(sidebar, /guardedSelectSession/);
    assert.match(workbench, /guardedCloseSidePane/);
    assert.match(sidePane, /guardedActivatePanel/);
    assert.match(sidePane, /guardedCloseActivePanel/);
    assert.match(settings, /guardedSetWorkspaceMode/);
});
