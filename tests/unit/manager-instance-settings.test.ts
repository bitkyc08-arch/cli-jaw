import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstanceSettingsNavigation, hydrateInstanceSettings, settingsDirtyAfter, useSettingsDirtyState } from '../../public/manager/src/hooks/useDashboardView';
import { createManagerCaptureKeydownHandler, runManagerShortcut, type ManagerShortcutRunnerDeps } from '../../public/manager/src/manager-shortcut-runner';
import { DEFAULT_MANAGER_SHORTCUT_KEYMAP } from '../../public/manager/src/manager-shortcuts';

test('saved Settings becomes Overview plus panel, including missing and invalid flags', () => {
    for (const flag of [undefined, false, true, 'true', 1, null]) {
        assert.deepEqual(hydrateInstanceSettings({ selectedTab: 'settings', instanceSettingsOpen: flag }),
            { selectedTab: 'overview', instanceSettingsOpen: true });
        assert.deepEqual(hydrateInstanceSettings({ selectedTab: 'logs', instanceSettingsOpen: flag }),
            { selectedTab: 'logs', instanceSettingsOpen: flag === true });
    }
});
test('dirty cancellation has no writes; same-port open preserves draft; accepted close persists the mode', () => {
    type Args = Parameters<typeof createInstanceSettingsNavigation>[0];
    const writes: Parameters<Args['saveUi']>[0][] = [], dirtyChanges: boolean[] = [], ports: (number | null)[] = [];
    let allowed = false, prompts = 0;
    const view: Args['view'] = { activeDetailTab: 'preview', instanceSettingsOpen: true,
        setInstanceSettingsOpen(next) { assert.equal(typeof next, 'boolean'); },
        setSelectedPort(next) { if (typeof next !== 'function') ports.push(next); },
        setSidebarMode() {}, setViewMode() {}, setDrawerOpen() {} };
    const nav = createInstanceSettingsNavigation({ view, selectedPort: 3457, settingsDirty: true, panelSettingsDirty: true,
        setSettingsDirty: dirty => dirtyChanges.push(dirty), clearPanelDirty: () => dirtyChanges.push(false), saveUi: async patch => { writes.push(patch); },
        confirmDiscard: () => { prompts++; return allowed; } });
    nav.setInstanceSettingsOpen(false); nav.setInstanceSettingsOpen(true, 3458);
    assert.equal(prompts, 2); assert.deepEqual(writes, []); assert.deepEqual(ports, []); assert.deepEqual(dirtyChanges, []);
    nav.setInstanceSettingsOpen(true, 3457);
    assert.equal(prompts, 2); assert.deepEqual(dirtyChanges, []); assert.equal(writes.at(-1)?.selectedTab, 'preview');
    allowed = true; nav.setInstanceSettingsOpen(true, 3458);
    assert.deepEqual(ports, [3457, 3458]); assert.deepEqual(dirtyChanges, [false]);
    nav.setInstanceSettingsOpen(false);
    assert.equal(writes.at(-1)?.instanceSettingsOpen, false); assert.equal(writes.at(-1)?.selectedTab, 'preview');
});
test('closed panel still guards Dashboard dirty on port changes', () => {
    type Args = Parameters<typeof createInstanceSettingsNavigation>[0];
    const writes: unknown[] = [], ports: unknown[] = [];
    let allow = false;
    const view: Args['view'] = { activeDetailTab: 'preview', instanceSettingsOpen: false,
        setInstanceSettingsOpen() {}, setSelectedPort: next => { ports.push(next); },
        setSidebarMode() {}, setViewMode() {}, setDrawerOpen() {} };
    const nav = createInstanceSettingsNavigation({ view, selectedPort: 3457, settingsDirty: true, panelSettingsDirty: false,
        setSettingsDirty() {}, clearPanelDirty() {}, confirmDiscard: () => allow,
        saveUi: async patch => { writes.push(patch); } });
    assert.equal(nav.canLeaveDirtySettings(), false); // row / Preview / CEO guard uses this even when closed
    nav.setInstanceSettingsOpen(true, 3458);
    assert.deepEqual(ports, []); assert.deepEqual(writes, []);
    allow = true; nav.setInstanceSettingsOpen(true, 3458);
    assert.deepEqual(ports, [3458]); assert.equal(writes.length, 1);
});
test('clean or closed panel cannot mask Dashboard dirty', () => {
    let entries = settingsDirtyAfter({ panel: false, dashboard: false }, 'dashboard', true);
    entries = settingsDirtyAfter(entries, 'panel', false);
    assert.equal(entries.panel || entries.dashboard, true);
    entries = settingsDirtyAfter(entries, 'dashboard', false);
    assert.equal(entries.panel || entries.dashboard, false);
});
test('shortcut toggle and tab cycling have separate owners', () => {
    let toggles = 0;
    const tabs: string[] = [];
    const deps: ManagerShortcutRunnerDeps = { selectedInstance: null, filtered: [], activeDetailTab: 'logs',
        toggleInstanceSettings() { toggles++; }, handleTabChange(tab) { tabs.push(tab); },
        setDrawerOpen() {}, handleSidebarModeChange() {}, handlePreview() {}, selectRelativeInstance() {},
        setPreviewRefreshKey() {}, handleSidebarToggle() {} };
    runManagerShortcut('toggleInstanceSettings', deps); assert.equal(toggles, 1);
    runManagerShortcut('nextTab', deps); assert.deepEqual(tabs, ['overview']);
    runManagerShortcut('switchTab4', deps); assert.deepEqual(tabs, ['overview', 'settings']);
    assert.equal(toggles, 1);
});

test('panel dirty callback stays stable through renders and cleanup preserves Dashboard dirty', async () => {
    const React = await import('react');
    const { JSDOM } = await import('jsdom');
    const { createRoot } = await import('react-dom/client');
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const globals = globalThis as unknown as Record<string, unknown>;
    const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(replacements)) globals[key] = value;
    const root = createRoot(dom.window.document.getElementById('root')!);
    let state: ReturnType<typeof useSettingsDirtyState> | undefined;
    let notifications = 0, cleanups = 0;
    function Panel(props: { onDirtyChange: (dirty: boolean) => void }) {
        React.useEffect(() => {
            notifications++;
            assert.ok(notifications < 5, 'dirty notifications must settle, not loop');
            props.onDirtyChange(true);
        }, [props.onDirtyChange]);
        React.useEffect(() => () => { cleanups++; props.onDirtyChange(false); }, [props.onDirtyChange]);
        return null;
    }
    function Harness(props: { open: boolean }) {
        state = useSettingsDirtyState();
        return props.open ? React.createElement(Panel, { onDirtyChange: state.onPanelSettingsDirtyChange }) : null;
    }
    try {
        await React.act(async () => { root.render(React.createElement(Harness, { open: true })); });
        assert.equal(state?.panelSettingsDirty, true);
        const callback = state?.onPanelSettingsDirtyChange;
        await React.act(async () => { state?.onSettingsDirtyChange('dashboard', true); });
        await React.act(async () => { root.render(React.createElement(Harness, { open: true })); });
        assert.equal(state?.onPanelSettingsDirtyChange, callback);
        assert.equal(notifications, 1); assert.equal(cleanups, 0);
        await React.act(async () => { root.render(React.createElement(Harness, { open: false })); });
        assert.equal(cleanups, 1); assert.equal(state?.panelSettingsDirty, false);
        assert.equal(state?.settingsDirty, true);
    } finally {
        await React.act(async () => { root.unmount(); });
        dom.window.close();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globals[key];
        }
    }
});

test('settings shortcut captures ordinary inputs once and yields to keybinding editors', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<input id="field"><input id="binding" data-keybinding-capture>');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Element');
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: dom.window.Element });
    const actions: string[] = [];
    let bubbled = 0;
    const handler = createManagerCaptureKeydownHandler(() => DEFAULT_MANAGER_SHORTCUT_KEYMAP, action => actions.push(action));
    dom.window.addEventListener('keydown', handler, true);
    dom.window.document.addEventListener('keydown', () => { bubbled++; });
    const key = () => new dom.window.KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true });
    try {
        const captured = key(); dom.window.document.getElementById('field')!.dispatchEvent(captured);
        assert.deepEqual(actions, ['toggleInstanceSettings']); assert.equal(captured.defaultPrevented, true);
        assert.equal(bubbled, 0);
        const editing = key(); dom.window.document.getElementById('binding')!.dispatchEvent(editing);
        assert.equal(editing.defaultPrevented, false); assert.equal(actions.length, 1); assert.equal(bubbled, 1);
        const prevented = key(); prevented.preventDefault();
        dom.window.document.getElementById('field')!.dispatchEvent(prevented);
        assert.equal(actions.length, 1);
    } finally {
        dom.window.removeEventListener('keydown', handler, true);
        dom.window.close();
        if (previous) Object.defineProperty(globalThis, 'Element', previous);
        else Reflect.deleteProperty(globalThis, 'Element');
    }
});
