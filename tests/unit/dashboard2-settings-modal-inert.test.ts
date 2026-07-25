// 260725 — Settings modal must inert its BACKGROUND SIBLINGS, never itself.
//
// Regression: the effect walked #dashboard2-root.children looking for "everything
// except the overlay". But Shell renders a single <main class="d2-shell"> and the
// modal lives INSIDE it, so the overlay was never in that child list — .d2-shell
// got inert, inert is inherited, and the whole app (modal included) went dead.
// Only the document-level Escape handler still worked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, act } from 'react';
import * as ReactNamespace from 'react';
import { JSDOM } from 'jsdom';
import type { PreferencesRegistryClient } from '../../public/dashboard2/src/providers/preferences-provider.tsx';

(globalThis as Record<string, unknown>).React = ReactNamespace;

const registry = {
    ui: {
        uiTheme: 'auto',
        locale: 'en',
        dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: 'default',
    },
} as never;

const prefsClient: PreferencesRegistryClient = {
    async load() { return { registry, status: {} }; },
    async patch() { return { registry, status: {} }; },
};

async function mountModal(): Promise<{
    doc: Document;
    shell: HTMLElement;
    sidebar: HTMLElement;
    workbench: HTMLElement;
    unmount: () => Promise<void>;
}> {
    const dom = new JSDOM('<div id="dashboard2-root"></div>');
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const [name, value] of Object.entries({
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement,
        Node: dom.window.Node,
        MutationObserver: dom.window.MutationObserver,
        matchMedia: (query: string) => ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            onchange: null,
            dispatchEvent: () => false,
        }),
        requestAnimationFrame: (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0),
        cancelAnimationFrame: (id: number) => dom.window.clearTimeout(id),
    })) Object.defineProperty(globalThis, name, { configurable: true, value });

    const doc = dom.window.document;
    const root = doc.getElementById('dashboard2-root')!;

    const { createRoot } = await import('react-dom/client');
    const { SettingsModal } = await import('../../public/dashboard2/src/shell/SettingsModal.tsx');
    const { ManagerPreferencesProvider } = await import('../../public/dashboard2/src/providers/preferences-provider.tsx');

    /*
     * Reproduce the REAL tree. Shell renders one <main class="d2-shell">; Sidebar
     * returns a fragment whose members (<aside> and <SettingsModal>) become direct
     * children of that main. So the overlay is a SIBLING of the sidebar and the
     * workbench, and a grandchild — not a child — of #dashboard2-root.
     *
     * React renders into d2-shell directly so the overlay lands as its direct
     * child, exactly like production.
     */
    const shell = doc.createElement('main');
    shell.className = 'd2-shell';
    root.appendChild(shell);
    const reactRoot = createRoot(shell);
    await act(async () => reactRoot.render(
        h(ManagerPreferencesProvider, { client: prefsClient },
            h(SettingsModal, { isOpen: true, onClose: () => {} })),
    ));

    /*
     * Sibling nodes are appended AFTER the React render, because createRoot
     * clears its container on mount. In production these siblings come from the
     * same Shell render, so being present before the modal's effect runs is what
     * matters — and the effect below re-runs via the modal's own mount effect
     * only once. To model "already present when the modal opened" we append them
     * first and then force the effect by remounting.
     */
    const sidebar = doc.createElement('aside');
    sidebar.className = 'd2-sidebar-v4';
    shell.insertBefore(sidebar, shell.firstChild);
    const workbench = doc.createElement('section');
    workbench.className = 'd2-workbench';
    shell.appendChild(workbench);
    await act(async () => { await Promise.resolve(); });

    return {
        doc,
        shell,
        sidebar,
        workbench,
        unmount: async () => { await act(async () => reactRoot.unmount()); },
    };
}

test('settings modal never inerts itself or the shell that contains it', async () => {
    const { doc, shell, sidebar, workbench, unmount } = await mountModal();

    const overlay = doc.querySelector('.d2-settings-modal') as HTMLElement | null;
    assert.ok(overlay, 'modal overlay must render');

    // The regression: .d2-shell carried inert, which killed the modal too.
    assert.equal(shell.hasAttribute('inert'), false, '.d2-shell must never be inert — it contains the modal');
    assert.equal(overlay.hasAttribute('inert'), false, 'the overlay itself must stay interactive');

    // Nothing on the path from the overlay up to the document may be inert,
    // because inert is inherited by the entire subtree.
    for (let node = overlay.parentElement; node; node = node.parentElement) {
        assert.equal(node.hasAttribute('inert'), false, `ancestor ${node.className || node.tagName} must not be inert`);
    }

    // The close button must be reachable and clickable.
    const closeButton = overlay.querySelector('.d2-settings-close') as HTMLElement | null;
    assert.ok(closeButton, 'close button must exist');
    assert.equal(closeButton.closest('[inert]'), null, 'close button must not sit inside an inert subtree');

    // Background siblings ARE inert.
    assert.equal(sidebar.hasAttribute('inert'), true, 'sidebar must be inert while the modal is open');
    assert.equal(workbench.hasAttribute('inert'), true, 'workbench must be inert while the modal is open');

    await unmount();
});

test('settings modal inerts siblings mounted while it is open', async () => {
    const { doc, shell, unmount } = await mountModal();

    // Shell's sidebar resize separator is conditional on the responsive
    // breakpoint, so a sibling can appear after the modal effect already ran.
    const lateSibling = doc.createElement('div');
    lateSibling.className = 'd2-sidebar-resize';
    shell.appendChild(lateSibling);
    await act(async () => { await Promise.resolve(); });

    assert.equal(lateSibling.hasAttribute('inert'), true, 'a sibling mounted while open must also become inert');

    await unmount();
});

test('settings modal cleanup restores only the inert attributes it added', async () => {
    const { doc, shell, sidebar, workbench, unmount } = await mountModal();

    // Workbench legitimately marks its own descendants inert (workspace
    // surfaces, side-pane slot). Cleanup must not resurrect those.
    const foreignInert = doc.createElement('div');
    foreignInert.className = 'd2-workbench-side-pane-slot';
    foreignInert.setAttribute('inert', '');
    workbench.appendChild(foreignInert);

    // A pre-existing inert sibling is also not ours to clear.
    const preInertSibling = doc.createElement('div');
    preInertSibling.className = 'pre-inert-sibling';
    preInertSibling.setAttribute('inert', '');
    shell.appendChild(preInertSibling);
    await act(async () => { await Promise.resolve(); });

    await unmount();

    assert.equal(sidebar.hasAttribute('inert'), false, 'our own inert must be removed on close');
    assert.equal(workbench.hasAttribute('inert'), false, 'our own inert must be removed on close');
    assert.equal(foreignInert.hasAttribute('inert'), true, 'descendant inert owned by Workbench must survive');
    assert.equal(preInertSibling.hasAttribute('inert'), true, 'a sibling that was already inert must stay inert');
});
