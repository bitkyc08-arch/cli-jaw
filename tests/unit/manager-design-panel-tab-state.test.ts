/**
 * 186 Phase 1 -- Design module tab state.
 *
 * - 'design' launcher focus-or-create vs '+' create (multi-instance)
 * - applyDesignTabState: pageId/zoom updates, projectKey create-time snapshot
 * - registry round-trip preserves design.pageId/projectKey/zoom
 * - legacy tabs without a design slot hydrate without crashing
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    focusOrCreateFirstRightSidebarTab,
    createRightSidebarTab,
    applyDesignTabState,
} from '../../public/manager/src/panels/PanelLayoutProvider.js';
import {
    panelLayoutInitialStateFromUi,
    panelLayoutUiFromState,
} from '../../public/manager/src/panels/panel-layout-registry-state.js';
import type { RightSidebarTabsState } from '../../public/manager/src/panels/types.js';
import { RIGHT_SIDEBAR_MULTI_INSTANCE_KINDS } from '../../public/manager/src/panels/types.js';
import type { DashboardRegistryUi } from '../../public/manager/src/types.js';

function emptyTabs(): RightSidebarTabsState {
    return { openTabs: [], activeTabId: null, nextOrdinalByKind: {} };
}

function makeUi(overrides: Partial<DashboardRegistryUi>): DashboardRegistryUi {
    return { rightFolderRootPath: null, ...overrides } as DashboardRegistryUi;
}

test('design is a multi-instance kind', () => {
    assert.ok(RIGHT_SIDEBAR_MULTI_INSTANCE_KINDS.includes('design'));
});

test('design launcher focuses the first design tab; plus-menu create makes new instances', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'design');
    assert.equal(tabs.openTabs[0].id, 'right-design-1');
    assert.equal(tabs.openTabs[0].specificName, 'Design 1');
    tabs = createRightSidebarTab(tabs, 'design');
    assert.equal(tabs.openTabs[1].id, 'right-design-2');
    assert.equal(tabs.nextOrdinalByKind.design, 3);
    const focused = focusOrCreateFirstRightSidebarTab(tabs, 'design');
    assert.equal(focused.openTabs.length, 2, 'launcher never duplicates');
    assert.equal(focused.activeTabId, 'right-design-1', 'launcher focuses the FIRST design tab');
});

test('applyDesignTabState updates pageId/zoom and snapshots projectKey once (OD-2)', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'design');
    tabs = applyDesignTabState(tabs, 'right-design-1', { projectKey: '/home/u/projA' });
    assert.equal(tabs.openTabs[0].design?.projectKey, '/home/u/projA');
    // Later instance switches must NOT retarget the tab.
    tabs = applyDesignTabState(tabs, 'right-design-1', { projectKey: '/home/u/projB' });
    assert.equal(tabs.openTabs[0].design?.projectKey, '/home/u/projA', 'projectKey is frozen at create');
    tabs = applyDesignTabState(tabs, 'right-design-1', { pageId: 'page-1', zoom: 1.25 });
    assert.equal(tabs.openTabs[0].design?.pageId, 'page-1');
    assert.equal(tabs.openTabs[0].design?.zoom, 1.25);
    // No-op patches return the same state object.
    const same = applyDesignTabState(tabs, 'right-design-1', { pageId: 'page-1' });
    assert.equal(same, tabs);
});

test('registry round-trip preserves design pageId/projectKey/zoom', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'design');
    tabs = applyDesignTabState(tabs, 'right-design-1', { projectKey: '/home/u/projA', pageId: 'page-9', zoom: 0.75 });
    const state = {
        rightPanel: {
            open: true,
            width: 480,
            tabs,
            fileFolderLayout: { mode: 'split' as const, splitRatio: 0.5, lastSplitRatio: 0.5 },
        },
        bottomPanel: { open: false, height: 320, tabs: [] as string[], activeTab: null },
    };
    const ui = panelLayoutUiFromState(state);
    const restored = panelLayoutInitialStateFromUi(makeUi(ui));
    const tab = restored.rightPanel!.tabs.openTabs[0];
    assert.equal(tab.kind, 'design');
    assert.equal(tab.design?.pageId, 'page-9');
    assert.equal(tab.design?.projectKey, '/home/u/projA');
    assert.equal(tab.design?.zoom, 0.75);
    assert.equal(restored.rightPanel!.tabs.nextOrdinalByKind.design, 2);
});

test('legacy persisted tabs without a design slot hydrate without crashing', () => {
    const ui = makeUi({
        panelLayoutVersion: 2,
        rightSidebarOpenTabs: [
            { id: 'right-files-1', kind: 'files', title: 'Files', specificName: 'Files 1' },
            { id: 'right-design-1', kind: 'design', title: 'Design' },
        ],
        rightSidebarActiveTabId: 'right-design-1',
    });
    const restored = panelLayoutInitialStateFromUi(ui);
    assert.equal(restored.rightPanel!.tabs.openTabs.length, 2);
    const design = restored.rightPanel!.tabs.openTabs[1];
    assert.equal(design.kind, 'design');
    assert.equal(design.specificName, 'Design 1', 'missing specificName falls back to the ordinal default');
    assert.equal(design.design, undefined, 'no design slot is fine');
    assert.equal(restored.rightPanel!.tabs.activeTabId, 'right-design-1');
});

test('applyDesignTabState ignores non-design tabs', () => {
    const tabs = createRightSidebarTab(emptyTabs(), 'files');
    const result = applyDesignTabState(tabs, 'right-files-1', { pageId: 'x' });
    assert.equal(result, tabs);
});
