import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('vite config includes manager entry and react plugin', () => {
    const vite = read('vite.config.ts');

    assert.ok(vite.includes("@vitejs/plugin-react"), 'Vite must include React plugin');
    assert.ok(vite.includes("manager: 'public/manager/index.html'"), 'Vite must include manager entry');
    assert.ok(vite.includes("app: 'public/index.html'"), 'Vite must preserve existing app entry');
});

test('frontend tsconfig typechecks manager TSX', () => {
    const tsconfig = read('tsconfig.frontend.json');

    assert.ok(tsconfig.includes('"jsx": "react-jsx"'), 'frontend tsconfig must enable react-jsx');
    assert.ok(tsconfig.includes('public/manager/src/**/*.tsx'), 'frontend tsconfig must include manager TSX');
    assert.ok(tsconfig.includes('public/manager/src/**/*.ts'), 'frontend tsconfig must include manager TS');
});

test('manager frontend has API entry and Open action', () => {
    assert.equal(existsSync(join(projectRoot, 'public/manager/index.html')), true);
    const api = read('public/manager/src/api.ts');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const command = read('public/manager/src/components/CommandBar.tsx');

    assert.ok(api.includes('/api/dashboard/instances'), 'manager API must call dashboard instances endpoint');
    assert.ok(api.includes('/api/dashboard/lifecycle/'), 'manager API must call dashboard lifecycle endpoint');
    assert.ok(api.includes('/api/dashboard/registry'), 'manager API must call dashboard registry endpoint');
    assert.ok(row.includes('Open'), 'manager UI must expose Open action');
    assert.ok(command.includes('Search port, home, CLI, model'), 'manager UI must include search');
});

test('manager frontend exposes one-instance preview controls', () => {
    const app = read('public/manager/src/App.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');
    const hook = read('public/manager/src/hooks/useDashboardView.ts');
    const preview = read('public/manager/src/InstancePreview.tsx');
    const helper = read('public/manager/src/preview.ts');
    const components = read('public/manager/src/manager-components.css');

    assert.ok(hook.includes('selectedPort'), 'manager UI must track a selected preview instance');
    assert.ok(app.includes('handleSelectInstance'), 'manager UI must allow selecting any instance row');
    assert.ok(app.includes('InstancePreview'), 'manager UI must render preview component');
    assert.equal(workbench.includes('contentByMode'), false, 'workbench must not unmount preview through contentByMode switching');
    assert.ok(workbench.includes('workbench-panel-preview'), 'workbench must render preview in a dedicated panel');
    assert.ok(workbench.includes("hidden={props.mode !== 'preview'}"), 'preview panel must hide without unmounting across tab changes');
    assert.ok(workbench.includes('data-preview-host="persistent"'), 'preview host must be explicitly persistent');
    assert.ok(workbench.includes('{props.preview}'), 'persistent preview panel must render the preview slot');
    assert.ok(components.includes('.workbench-panel'), 'workbench panels must have stable sizing');
    assert.ok(components.includes('.workbench-panel[hidden]'), 'inactive persistent preview panel must not reserve space');
    assert.ok(preview.includes('<iframe'), 'preview component must mount iframe');
    assert.ok(preview.includes('clipboard-read; clipboard-write'), 'preview iframe must explicitly allow clipboard read/write');
    assert.ok(app.includes('preview-inline-status'), 'workbench header must expose compact preview status');
    assert.equal(preview.includes('preview-status-row'), false, 'preview iframe area must not spend a row on status');
    assert.equal(preview.includes('Enable preview'), false, 'preview tab must not require a second enable toggle');
    assert.equal(preview.includes('<select'), false, 'preview mode dropdown must be removed');
    assert.equal(helper.includes("transport: 'direct'"), false, 'preview helper must not expose direct iframe mode');
    assert.ok(helper.includes('buildPreviewState'), 'preview helper must centralize URL state');
    assert.ok(helper.includes('/i'), 'preview helper must support manager proxy base path');
});

test('manager frontend exposes lifecycle controls without hiding discovery actions', () => {
    const app = read('public/manager/src/App.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const types = read('public/manager/src/types.ts');

    assert.ok(types.includes('DashboardLifecycleCapability'), 'frontend types must include lifecycle capability');
    assert.ok(types.includes("'manager'"), 'frontend service mode must represent manager-owned instances');
    assert.ok(app.includes('handleLifecycle'), 'manager UI must keep lifecycle controller');
    assert.ok(row.includes("onLifecycle('start'"), 'manager UI must expose Start action');
    assert.ok(row.includes("onLifecycle('stop'"), 'manager UI must expose Stop action');
    assert.ok(row.includes("onLifecycle('restart'"), 'manager UI must expose Restart action');
    assert.ok(row.includes('Preview'), 'manager UI must keep Preview action');
    assert.ok(row.includes('Open'), 'manager UI must keep Open action');
});

test('manager instance activity unread badges are row-scoped and registry-backed', () => {
    const app = read('public/manager/src/App.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const rail = read('public/manager/src/components/SidebarRail.tsx');
    const helper = read('public/manager/src/activity-unread.ts');
    const hook = read('public/manager/src/hooks/useActivityUnread.ts');
    const messageHook = read('public/manager/src/hooks/useInstanceMessageEvents.ts');
    const types = read('public/manager/src/types.ts');

    assert.ok(helper.includes('isUnreadActivityEvent'), 'activity unread helper must classify response events');
    assert.ok(helper.includes('countUnreadActivityEvents'), 'activity unread helper must expose count derivation');
    assert.ok(helper.includes('countUnreadActivityEventsByPort'), 'activity unread helper must expose per-instance count derivation');
    assert.ok(helper.includes('latestManagerEventAt'), 'activity unread helper must expose mark-seen timestamp derivation');
    assert.ok(helper.includes('latestManagerEventAtForPort'), 'activity unread helper must expose per-port mark-seen timestamp derivation');
    assert.ok(helper.includes('activityEventDedupeKey'), 'activity unread helper must dedupe repeated events');
    assert.ok(helper.includes("event.kind === 'instance-message' && event.role === 'assistant'"), 'only assistant messages must count for unread activity');
    assert.equal(helper.includes("event.kind === 'health-changed'"), false, 'health changes must not inflate response unread counts');
    assert.equal(helper.includes("event.kind === 'lifecycle-result'"), false, 'lifecycle events must not inflate response unread counts');
    assert.equal(helper.includes("event.kind === 'port-collision'"), false, 'port collisions must not inflate response unread counts');
    assert.ok(hook.includes('seenActivityAt'), 'activity unread hook must track the last seen activity timestamp');
    assert.ok(hook.includes('seenActivityByPort'), 'activity unread hook must track per-port seen timestamps');
    assert.ok(hook.includes('markPortSeen'), 'activity unread hook must expose click-to-clear behavior for one row');
    assert.ok(hook.includes('Date.parse(latest) <= Date.parse(portSeenAt)'), 'markPortSeen must avoid redundant per-port seen saves');
    assert.ok(hook.includes('Date.parse(latest) <= Date.parse(seenActivityAt)'), 'markPortSeen must respect global seen timestamps before saving');
    assert.ok(app.includes('activitySeenAt'), 'App must hydrate/persist activitySeenAt through registry UI');
    assert.ok(app.includes('activitySeenByPort'), 'App must hydrate/persist per-port activity seen state');
    assert.ok(hook.includes('if (!options.activityDockCollapsed) return {}'), 'App must hide row unread counts while Activity is open');
    assert.ok(app.includes('activityUnread.unreadByPort'), 'App must pass per-port unread counts into instance groups');
    assert.ok(app.includes('useInstanceMessageEvents(instances)'), 'App must poll instance messages without dashboard refresh');
    assert.ok(app.includes('activityUnread.markPortSeen'), 'App must mark the selected instance as seen when clicked');
    assert.ok(app.includes("view.activeDetailTab !== 'preview'"), 'App must only auto-clear unread state while Preview is active');
    assert.ok(app.includes('!selectedInstance?.ok'), 'App must not auto-clear unread state for offline or missing preview targets');
    assert.ok(app.includes('selectedInstance.port !== view.selectedPort'), 'App must not auto-clear unread state for fallback selected instances');
    assert.ok(app.includes('onToggleActivity={activityUnread.openAndMarkSeen}'), 'mobile Activity open path must mark events as seen');
    assert.ok(types.includes('activitySeenAt: string | null'), 'frontend registry UI type must include activitySeenAt');
    assert.ok(types.includes('activitySeenByPort: Record<string, string>'), 'frontend registry UI type must include per-port seen state');
    assert.ok(groups.includes('activityUnreadByPort'), 'InstanceGroups must accept per-port unread counts');
    assert.ok(row.includes('activityUnreadCount'), 'InstanceRow must accept unread count');
    assert.ok(row.includes('onMarkActivitySeen'), 'InstanceRow must clear the clicked instance unread count');
    assert.ok(row.includes('instance-unread-badge'), 'InstanceRow must render the compact row badge');
    assert.ok(row.includes('99+'), 'InstanceRow badge must cap large counts');
    assert.equal(rail.includes('label="Instances"'), false, 'SidebarRail must not duplicate the Workbench instance tab');
    assert.equal(rail.includes('label="Preview"'), false, 'SidebarRail must not duplicate the Workbench preview tab');
    assert.equal(rail.includes('label="Activity"'), false, 'SidebarRail must not duplicate the Activity dock toggle');
    assert.equal(rail.includes('label="Settings"'), false, 'SidebarRail must not duplicate the Workbench settings tab');
    assert.equal(rail.includes('activityUnreadCount'), false, 'SidebarRail must not show the unread count on the top Activity item');
    assert.equal(rail.includes('rail-badge'), false, 'SidebarRail must not render the Activity unread badge');
    assert.equal(app.includes('attention-badge'), false, 'manager dashboard must not import legacy chat attention badge');
    assert.equal(app.includes('setAppBadge'), false, 'manager dashboard must not use browser app badge APIs');
    assert.equal(app.includes('document.title'), false, 'manager dashboard must not mutate document title for unread activity');
    assert.ok(messageHook.includes('/i/${port}/api/messages/latest'), 'message unread hook must poll only the latest proxied instance message');
    assert.equal(messageHook.includes('api/messages`'), false, 'message unread hook must not poll full message history');
    assert.ok(messageHook.includes('POLL_INTERVAL_MS = 5_000'), 'message unread hook must refresh without manual dashboard reload');
    assert.ok(messageHook.includes('previousId == null'), 'message unread hook must baseline existing messages without backfilling badges');
});

test('manager process control panel exposes safe managed-process actions only', () => {
    const panel = read('public/manager/src/components/ProcessControlPanel.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const api = read('public/manager/src/api.ts');
    const types = read('public/manager/src/types.ts');
    const server = read('src/manager/server.ts');

    assert.ok(detail.includes('ProcessControlPanel'), 'overview must render the process control panel');
    assert.ok(panel.includes('Stop all managed'), 'panel must expose Stop all managed');
    assert.ok(panel.includes('Adopt/recover'), 'panel must expose Adopt/recover');
    assert.ok(panel.includes('Force release port'), 'panel must show force release as a planned control');
    assert.ok(panel.includes('<button type="button" disabled'), 'force release must not be clickable in this slice');
    assert.ok(api.includes('/api/dashboard/process-control/stop-managed'), 'frontend API must call stop-managed');
    assert.ok(api.includes('/api/dashboard/process-control/adopt'), 'frontend API must call adopt');
    assert.ok(types.includes('DashboardProcessControlState'), 'frontend types must include process control state');
    assert.ok(server.includes('/api/dashboard/process-control/force-release'), 'backend must explicitly reject force release for now');
    assert.ok(server.includes('501'), 'force release route must be unsupported until strict proof exists');
});

test('manager frontend keeps rows compact while preserving model visibility', () => {
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const compact = read('public/manager/src/manager-p0-1-1.css');
    const main = read('public/manager/src/main.tsx');

    assert.ok(row.includes('instance-row-runtime'), 'instance rows must expose CLI/model as a stable runtime line');
    assert.ok(row.includes('instance-row-version'), 'instance rows must keep version metadata addressable');
    assert.ok(row.includes('instance-row-reason'), 'instance rows must keep reason metadata addressable');
    assert.ok(main.includes('./manager-p0-1-1.css'), 'P0-1.1 compact manager CSS must be loaded last');
    assert.ok(compact.includes('.manager-sidebar .instance-row-version'), 'sidebar polish must hide secondary row metadata in compact mode');
    assert.ok(compact.includes('.manager-sidebar .instance-actions'), 'sidebar polish must control action-row density');
    assert.ok(compact.includes('.manager-shell.is-sidebar-collapsed .manager-workspace'), 'sidebar collapse must reclaim detail width');
});

test('manager instance rows are selectable independently from preview availability', () => {
    const app = read('public/manager/src/App.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');

    assert.ok(row.includes('className="instance-row-select"'), 'instance row body must expose a dedicated select control');
    assert.ok(row.includes('type="button"'), 'instance row selection must be button-based and keyboard reachable');
    assert.ok(row.includes('onSelect(props.instance)'), 'row click/key must select the row instance');
    assert.ok(groups.includes('onSelect={props.onSelect}'), 'group list must forward row selection');
    // 10.6.10 — row selection must preserve the active workbench tab (no
    // forced reset to overview) so users keep their Preview/Logs/Settings
    // context when hopping between instances. Explicit jumps stay on
    // handlePreview.
    assert.ok(!app.includes("view.setActiveDetailTab('overview')"), 'row selection must NOT force-reset detail tab');
    assert.ok(app.includes('view.setDrawerOpen(false)'), 'row selection must close the mobile drawer');
});

test('manager navigator does not exclude the selected instance from profile groups', () => {
    const app = read('public/manager/src/App.tsx');
    const navigator = read('public/manager/src/components/InstanceNavigator.tsx');

    assert.equal(app.includes('renderInstanceListContent(true)'), false, 'selected instance must remain in the grouped list after removing duplicate active card');
    assert.equal(app.includes('filtered.filter(instance => instance.port !== selectedInstance.port)'), false, 'App must not remove selected instances from sidebar groups');
    assert.equal(navigator.includes('InstanceRow'), false, 'InstanceNavigator must not render a second selected instance card');
});

test('manager profile rows merge profile headers into the instance row', () => {
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const components = read('public/manager/src/manager-components.css');
    const compact = read('public/manager/src/manager-p0-1-1.css');

    assert.equal(groups.includes("import { ProfileSection }"), false, 'profile groups must not render a separate profile header card');
    assert.ok(groups.includes('function sortProfiles'), 'profile groups must use a stable ordering helper');
    assert.ok(groups.includes("profile.label === 'default'"), 'default profile must be ranked first');
    assert.ok(groups.includes('is-profile-merged'), 'profile instance groups must expose merged-row styling');
    assert.ok(groups.includes('profile={profile}'), 'profile context must be forwarded into the row');
    assert.ok(row.includes('props.profile?.label'), 'instance row must use the profile label as the primary merged label');
    assert.equal(row.includes('instanceSecondaryLine'), false, 'instance row must not add path metadata under compact sidebar labels');
    assert.ok(row.includes('instance-row-transition'), 'instance row may still show transition state under the primary label');
    assert.ok(compact.includes('.profile-instance-groups.is-profile-merged .instance-row-main'), 'merged sidebar rows must align primary labels from the top-left row area');
    assert.ok(components.includes('.instance-row-select'), 'base row select styling must exist');
    assert.ok(components.includes('justify-self: stretch'), 'all selected rows must keep the same left alignment width');
    assert.ok(components.includes('width: 100%; min-height: 0'), 'base row selection must span the full row width');
    assert.ok(compact.includes('justify-self: stretch'), 'selected rows must not shrink their select area and visually center labels');
    assert.ok(compact.includes('width: 100%'), 'selected and non-selected rows must share the same left alignment width');
});

test('manager frontend routes layout through responsive shell components', () => {
    const app = read('public/manager/src/App.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');

    assert.ok(app.includes('ManagerShell'), 'App must use ManagerShell after 10.5.2 extraction');
    assert.ok(app.includes('CommandBar'), 'App must render CommandBar');
    assert.ok(app.includes('InstanceGroups'), 'App must render grouped instance list');
    assert.ok(app.includes('ActivityDock'), 'App must render ActivityDock');
    assert.ok(workbench.includes("'overview'"), 'workbench must expose Overview tab');
    assert.ok(workbench.includes("'preview'"), 'workbench must expose Preview tab');
    assert.ok(workbench.includes("'logs'"), 'workbench must expose Logs tab');
    assert.ok(workbench.includes("'settings'"), 'workbench must expose Settings tab');
    assert.ok(detail.includes("props.activeTab === 'overview'"), 'detail panel must render Overview content');
    assert.ok(detail.includes("props.activeTab === 'logs'"), 'detail panel must render Logs content');
    assert.ok(detail.includes("props.activeTab === 'settings'"), 'detail panel must render Settings content');
});

test('manager frontend exposes 10.6 persistence controls', () => {
    const app = read('public/manager/src/App.tsx');
    const hook = read('public/manager/src/hooks/useDashboardRegistry.ts');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const dashboardMeta = read('public/manager/src/settings/pages/DashboardMeta.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const command = read('public/manager/src/components/CommandBar.tsx');
    const main = read('public/manager/src/main.tsx');

    assert.ok(hook.includes('patchDashboardRegistry'), 'registry hook must save dashboard registry patches');
    assert.ok(app.includes('useDashboardRegistry'), 'App must hydrate and save registry state');
    assert.ok(detail.includes('SettingsShell'), 'Settings tab must mount the settings shell');
    assert.ok(dashboardMeta.includes('Pin favorite'), 'Settings tab must expose favorite pinning');
    assert.ok(dashboardMeta.includes('Hide by default'), 'Settings tab must expose hidden state');
    assert.ok(groups.includes("id: 'active'"), 'InstanceGroups must keep active row in a top group');
    assert.ok(groups.includes("id: 'favorites'"), 'InstanceGroups must keep pinned favorites near the top');
    assert.equal(command.includes('onScanRangeCommit'), false, 'CommandBar must not carry scan controls in the top row');
    assert.ok(main.includes('./manager-persistence.css'), 'manager persistence styling must be split into its own CSS module');
});

test('manager frontend exposes 10.8 profile controls', () => {
    const app = read('public/manager/src/App.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const drawer = read('public/manager/src/components/InstanceDrawer.tsx');
    const main = read('public/manager/src/main.tsx');

    assert.ok(existsSync(join(projectRoot, 'public/manager/src/components/ProfileChip.tsx')), 'ProfileChip must exist');
    assert.ok(existsSync(join(projectRoot, 'public/manager/src/components/ProfileSection.tsx')), 'ProfileSection must exist');
    assert.ok(app.includes('activeProfileIds'), 'App must own active profile filter state');
    assert.ok(app.includes('activeProfileFilter'), 'App must persist active profile filters through registry');
    assert.ok(groups.includes('is-profile-merged'), 'InstanceGroups must merge profile sections into instance rows');
    assert.ok(drawer.includes('drawer-profile-filters'), 'mobile drawer must mirror profile filters');
    assert.ok(main.includes('./manager-profiles.css'), 'profile styling must stay split from large CSS files');
});
