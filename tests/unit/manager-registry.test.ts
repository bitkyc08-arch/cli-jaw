import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    applyDashboardRegistry,
    defaultDashboardRegistry,
    loadDashboardRegistry,
    patchDashboardRegistry,
} from '../../src/manager/registry.js';
import type { DashboardInstance, DashboardScanResult } from '../../src/manager/types.js';

function registryPath(name = 'manager-instances.json'): string {
    return join(mkdtempSync(join(tmpdir(), 'jaw-manager-registry-')), name);
}

function makeInstance(port: number): DashboardInstance {
    return {
        port,
        url: `http://localhost:${port}`,
        status: 'online',
        ok: true,
        version: '1.0.0',
        uptime: 1,
        instanceId: `instance-${port}`,
        homeDisplay: null,
        workingDir: null,
        projectDirs: null,
        currentCli: null,
        currentModel: null,
        serviceMode: 'unknown',
        profileId: `profile-${port}`,
        lastCheckedAt: '2026-04-27T00:00:00.000Z',
        healthReason: null,
    };
}

function makeScan(): DashboardScanResult {
    return {
        manager: {
            port: 24576,
            rangeFrom: 3457,
            rangeTo: 3458,
            checkedAt: '2026-04-27T00:00:00.000Z',
            proxy: { enabled: true, basePath: '/i', allowedFrom: 3457, allowedTo: 3458 },
        },
        instances: [makeInstance(3457), makeInstance(3458)],
    };
}

test('manager registry defaults when file is missing', () => {
    const path = registryPath();
    const loaded = loadDashboardRegistry({ path });

    assert.equal(loaded.registry.scan.from, 3457);
    assert.equal(loaded.registry.scan.count, 50);
    assert.equal(loaded.registry.ui.selectedTab, 'overview');
    assert.equal(loaded.registry.ui.activitySeenAt, null);
    assert.deepEqual(loaded.registry.ui.activitySeenByPort, {});
    assert.equal(loaded.registry.ui.locale, 'ko');
    assert.equal(loaded.registry.ui.sidebarMode, 'instances');
    assert.equal(loaded.registry.ui.showLatestActivityTitles, true);
    assert.equal(loaded.registry.ui.showInlineLabelEditor, true);
    assert.equal(loaded.registry.ui.showSidebarRuntimeLine, true);
    assert.equal(loaded.registry.ui.showSelectedRowActions, true);
    assert.equal(loaded.registry.ui.dashboardShortcutsEnabled, true);
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.focusInstances, 'Alt+I');
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.focusActiveSession, 'Alt+P');
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.focusNotes, 'Alt+N');
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.previousInstance, 'Alt+K');
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.nextInstance, 'Alt+J');
    assert.equal(loaded.registry.ui.diffRootPolicy, 'project-first');
    assert.deepEqual(loaded.registry.ui.diffPinnedRootByPort, {});
    assert.deepEqual(loaded.registry.ui.diffRecentRepoRoots, []);
    assert.equal(loaded.registry.ui.diffDefaultMode, 'unstaged');
    assert.equal(loaded.registry.ui.diffBaseRef, 'HEAD');
    assert.equal(loaded.registry.ui.diffIncludeUntracked, true);
    assert.equal(loaded.registry.ui.notesGraphSettings.version, 1);
    assert.equal(loaded.registry.ui.notesGraphSettings.existingFilesOnly, false);
    assert.equal(loaded.registry.ui.notesGraphSettings.showOrphans, true);
    assert.deepEqual(loaded.registry.profiles, {});
    assert.deepEqual(loaded.registry.activeProfileFilter, []);
    assert.equal(loaded.status.loaded, true);
    assert.equal(loaded.status.error, null);
    assert.equal(loaded.status.path, path);
    assert.equal(loaded.status.migratedFrom, null);
});

test('manager registry falls back safely on invalid JSON', () => {
    const path = registryPath();
    writeFileSync(path, '{not-json');

    const loaded = loadDashboardRegistry({ path });

    assert.equal(loaded.status.loaded, false);
    assert.equal(loaded.status.path, path);
    assert.equal(loaded.status.migratedFrom, null);
    assert.match(String(loaded.status.error), /JSON/);
    assert.deepEqual(loaded.registry, defaultDashboardRegistry());
});

test('manager registry clamps scan and UI values', () => {
    const path = registryPath();
    writeFileSync(path, JSON.stringify({
        scan: { from: -1, count: 5000 },
        ui: {
            selectedPort: 999999,
            selectedTab: 'bad',
            sidebarCollapsed: true,
            activityDockCollapsed: true,
            activityDockHeight: 9999,
            activitySeenAt: 'not-date',
            activitySeenByPort: {
                3462: '2026-04-29T04:40:00.000Z',
                bad: '2026-04-29T04:40:00.000Z',
                3463: 'bad-date',
            },
            locale: 'en',
            sidebarMode: 'reminders',
            showLatestActivityTitles: false,
            showInlineLabelEditor: 'bad',
            showSidebarRuntimeLine: false,
            showSelectedRowActions: 'bad',
            dashboardShortcutsEnabled: false,
            dashboardShortcutKeymap: {
                focusInstances: 'alt+i',
                focusActiveSession: '',
                focusNotes: 'Ctrl+Shift+n',
                previousInstance: 'Option+ArrowUp',
                nextInstance: 42,
            },
            diffRootPolicy: 'working-dir-first',
            diffPinnedRootByPort: {
                3462: '/Users/jun/Developer/new/700_projects/cli-jaw',
                bad: '/tmp/ignored',
            },
            diffRecentRepoRoots: [
                ' /Users/jun/Developer/new/700_projects/cli-jaw ',
                '/Users/jun/Developer/new/700_projects/cli-jaw',
                '',
                42,
                '/Users/jun/Developer/new/700_projects/other',
            ],
            diffDefaultMode: 'base',
            diffBaseRef: ' origin/master ',
            diffIncludeUntracked: false,
            notesGraphSettings: {
                version: 99,
                panelOpen: false,
                collapsedSections: { filters: true, bad: true },
                query: ' tag:core ',
                existingFilesOnly: true,
                showOrphans: false,
                showTags: false,
                showAttachments: true,
                focusSelected: true,
                focusDepth: 99,
                groupMode: 'query',
                groups: [
                    { id: ' hot ', label: ' Hot ', query: 'tag:hot', color: '#ff7b72', enabled: false },
                    { id: 'empty', label: 'Empty', query: '', color: 'bad', enabled: true },
                ],
                nodeSize: 99,
                linkDistance: 999,
                chargeStrength: -9999,
                labelDensity: 5,
                showArrows: true,
                animate: false,
            },
        },
        instances: {
            3457: { label: ' main ', favorite: true, group: 'daily', hidden: false },
            bad: { label: 'ignored' },
        },
        profiles: {
            default: { label: ' Default ', homePath: '/Users/jun/.cli-jaw', pinned: true },
            bad_profile: { label: 'ignored' },
        },
        activeProfileFilter: ['default', 'BAD'],
    }));

    const loaded = loadDashboardRegistry({ path });

    assert.equal(loaded.registry.scan.from, 3457);
    assert.equal(loaded.registry.scan.count, 50);
    assert.equal(loaded.registry.ui.selectedPort, 65535);
    assert.equal(loaded.registry.ui.selectedTab, 'overview');
    assert.equal(loaded.registry.ui.sidebarCollapsed, true);
    assert.equal(loaded.registry.ui.activityDockHeight, 320);
    assert.equal(loaded.registry.ui.activitySeenAt, null);
    assert.deepEqual(loaded.registry.ui.activitySeenByPort, { 3462: '2026-04-29T04:40:00.000Z' });
    assert.equal(loaded.registry.ui.locale, 'en');
    assert.equal(loaded.registry.ui.sidebarMode, 'reminders');
    assert.equal(loaded.registry.ui.showLatestActivityTitles, false);
    assert.equal(loaded.registry.ui.showInlineLabelEditor, true);
    assert.equal(loaded.registry.ui.showSidebarRuntimeLine, false);
    assert.equal(loaded.registry.ui.showSelectedRowActions, true);
    assert.equal(loaded.registry.ui.dashboardShortcutsEnabled, false);
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.focusInstances, 'Alt+I');
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.focusActiveSession, 'Alt+P');
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.focusNotes, 'Ctrl+Shift+N');
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.previousInstance, 'Alt+ArrowUp');
    assert.equal(loaded.registry.ui.dashboardShortcutKeymap.nextInstance, 'Alt+J');
    assert.equal(loaded.registry.ui.diffRootPolicy, 'working-dir-first');
    assert.deepEqual(loaded.registry.ui.diffPinnedRootByPort, { 3462: '/Users/jun/Developer/new/700_projects/cli-jaw' });
    assert.deepEqual(loaded.registry.ui.diffRecentRepoRoots, [
        '/Users/jun/Developer/new/700_projects/cli-jaw',
        '/Users/jun/Developer/new/700_projects/other',
    ]);
    assert.equal(loaded.registry.ui.diffDefaultMode, 'base');
    assert.equal(loaded.registry.ui.diffBaseRef, 'origin/master');
    assert.equal(loaded.registry.ui.diffIncludeUntracked, false);
    assert.deepEqual(loaded.registry.ui.notesGraphSettings.collapsedSections, { filters: true });
    assert.equal(loaded.registry.ui.notesGraphSettings.query, 'tag:core');
    assert.equal(loaded.registry.ui.notesGraphSettings.existingFilesOnly, true);
    assert.equal(loaded.registry.ui.notesGraphSettings.showOrphans, false);
    assert.equal(loaded.registry.ui.notesGraphSettings.focusDepth, 4);
    assert.equal(loaded.registry.ui.notesGraphSettings.nodeSize, 2);
    assert.equal(loaded.registry.ui.notesGraphSettings.linkDistance, 240);
    assert.equal(loaded.registry.ui.notesGraphSettings.chargeStrength, -800);
    assert.equal(loaded.registry.ui.notesGraphSettings.labelDensity, 1);
    assert.equal(loaded.registry.ui.notesGraphSettings.groups.length, 1);
    assert.equal(loaded.registry.ui.notesGraphSettings.groups[0]?.label, 'Hot');
    assert.equal(loaded.registry.instances['3457']?.label, 'main');
    assert.equal(loaded.registry.instances.bad, undefined);
    assert.equal(loaded.registry.profiles.default?.label, 'Default');
    assert.deepEqual(loaded.registry.activeProfileFilter, ['default']);
});

test('manager registry patch persists instance preferences', () => {
    const path = registryPath();
    const saved = patchDashboardRegistry({
        scan: { from: 3460, count: 8 },
        ui: {
            selectedPort: 3461,
            selectedTab: 'settings',
            sidebarMode: 'reminders',
            activitySeenAt: '2026-04-29T04:40:00.000Z',
            activitySeenByPort: { 3461: '2026-04-29T04:41:00.000Z' },
            locale: 'en',
            showLatestActivityTitles: false,
            showInlineLabelEditor: false,
            showSidebarRuntimeLine: false,
            showSelectedRowActions: false,
            dashboardShortcutsEnabled: false,
            dashboardShortcutKeymap: {
                focusInstances: 'Alt+1',
                focusActiveSession: 'Alt+2',
                focusNotes: 'Alt+3',
                previousInstance: 'Alt+ArrowUp',
                nextInstance: 'Alt+ArrowDown',
            },
            diffRootPolicy: 'manual',
            diffPinnedRootByPort: { 3461: '/Users/jun/Developer/new/700_projects/cli-jaw' },
            diffRecentRepoRoots: ['/Users/jun/Developer/new/700_projects/cli-jaw'],
            diffDefaultMode: 'staged',
            diffBaseRef: 'main',
            diffIncludeUntracked: false,
            notesGraphSettings: {
                version: 1,
                panelOpen: true,
                collapsedSections: { groups: true },
                query: 'kind:missing',
                existingFilesOnly: false,
                showOrphans: true,
                showTags: true,
                showAttachments: false,
                focusSelected: true,
                focusDepth: 2,
                groupMode: 'query',
                groups: [{ id: 'missing', label: 'Missing', query: 'kind:missing', color: '#ff7b72', enabled: true }],
                nodeSize: 1.2,
                linkDistance: 110,
                chargeStrength: -240,
                labelDensity: 0.7,
                showArrows: true,
                animate: false,
            },
        },
        instances: { 3461: { label: 'worker', favorite: true, hidden: true } },
        profiles: { default: { label: 'Default', homePath: '/Users/jun/.cli-jaw', pinned: true } },
        activeProfileFilter: ['default'],
    }, { path });

    assert.equal(saved.registry.scan.from, 3460);
    assert.equal(saved.registry.scan.count, 8);
    assert.equal(saved.registry.ui.selectedTab, 'settings');
    assert.equal(saved.registry.ui.sidebarMode, 'reminders');
    assert.equal(saved.registry.ui.activitySeenAt, '2026-04-29T04:40:00.000Z');
    assert.deepEqual(saved.registry.ui.activitySeenByPort, { 3461: '2026-04-29T04:41:00.000Z' });
    assert.equal(saved.registry.ui.locale, 'en');
    assert.equal(saved.registry.ui.showLatestActivityTitles, false);
    assert.equal(saved.registry.ui.showInlineLabelEditor, false);
    assert.equal(saved.registry.ui.showSidebarRuntimeLine, false);
    assert.equal(saved.registry.ui.showSelectedRowActions, false);
    assert.equal(saved.registry.ui.dashboardShortcutsEnabled, false);
    assert.equal(saved.registry.ui.dashboardShortcutKeymap.focusInstances, 'Alt+1');
    assert.equal(saved.registry.ui.dashboardShortcutKeymap.nextInstance, 'Alt+ArrowDown');
    assert.equal(saved.registry.ui.diffRootPolicy, 'manual');
    assert.deepEqual(saved.registry.ui.diffPinnedRootByPort, { 3461: '/Users/jun/Developer/new/700_projects/cli-jaw' });
    assert.deepEqual(saved.registry.ui.diffRecentRepoRoots, ['/Users/jun/Developer/new/700_projects/cli-jaw']);
    assert.equal(saved.registry.ui.diffDefaultMode, 'staged');
    assert.equal(saved.registry.ui.diffBaseRef, 'main');
    assert.equal(saved.registry.ui.diffIncludeUntracked, false);
    assert.equal(saved.registry.ui.notesGraphSettings.query, 'kind:missing');
    assert.equal(saved.registry.ui.notesGraphSettings.groups[0]?.id, 'missing');
    assert.equal(saved.registry.ui.notesGraphSettings.focusDepth, 2);
    assert.equal(saved.registry.instances['3461']?.label, 'worker');
    assert.equal(saved.registry.instances['3461']?.favorite, true);
    assert.equal(saved.registry.instances['3461']?.hidden, true);
    assert.equal(saved.registry.profiles.default?.pinned, true);
    assert.deepEqual(saved.registry.activeProfileFilter, ['default']);
});

test('manager registry overlays scan results and hides hidden rows by default', () => {
    const registry = defaultDashboardRegistry();
    registry.instances['3457'] = { label: 'main', favorite: true, group: 'daily', hidden: false };
    registry.instances['3458'] = { label: 'hidden', favorite: false, group: null, hidden: true };
    const status = { path: '/tmp/registry.json', loaded: true, error: null, ui: registry.ui };

    const visible = applyDashboardRegistry(makeScan(), registry, status);
    const withHidden = applyDashboardRegistry(makeScan(), registry, status, { showHidden: true });

    assert.deepEqual(visible.instances.map(instance => instance.port), [3457]);
    assert.equal(visible.instances[0]?.label, 'main');
    assert.equal(visible.instances[0]?.favorite, true);
    assert.ok(Array.isArray(visible.manager.profiles));
    assert.deepEqual(withHidden.instances.map(instance => instance.port), [3457, 3458]);
    assert.equal(withHidden.instances[1]?.hidden, true);
});

test('manager registry clears blank instance labels back to fallback', () => {
    const path = registryPath();
    patchDashboardRegistry({
        instances: { 3462: { label: 'dashboard qa' } },
    }, { path });

    const saved = patchDashboardRegistry({
        instances: { 3462: { label: '' } },
    }, { path });

    assert.equal(saved.registry.instances['3462']?.label, null);
});

test('instance settings UI is a bounded boolean and its shortcut survives disk round-trip', () => {
    const path = registryPath();
    assert.equal(loadDashboardRegistry({ path }).registry.ui.instanceSettingsOpen, false);
    for (const value of [true, false, 'true', 1, {}, null]) {
        writeFileSync(path, JSON.stringify({ ui: { selectedTab: 'settings', instanceSettingsOpen: value } }));
        const ui = loadDashboardRegistry({ path }).registry.ui;
        assert.equal(ui.instanceSettingsOpen, value === true);
        assert.equal(ui.selectedTab, 'settings');
    }
    patchDashboardRegistry({ ui: { selectedTab: 'overview', instanceSettingsOpen: true,
        dashboardShortcutKeymap: { ...defaultDashboardRegistry().ui.dashboardShortcutKeymap, toggleInstanceSettings: 'Alt+S' } } }, { path });
    assert.equal(loadDashboardRegistry({ path }).registry.ui.instanceSettingsOpen, true);
    assert.equal(loadDashboardRegistry({ path }).registry.ui.dashboardShortcutKeymap.toggleInstanceSettings, 'Alt+S');
    patchDashboardRegistry({ ui: { instanceSettingsOpen: false } }, { path });
    assert.equal(loadDashboardRegistry({ path }).registry.ui.instanceSettingsOpen, false);
});
