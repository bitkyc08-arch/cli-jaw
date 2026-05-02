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
    assert.ok(api.includes('/api/dashboard/notes/tree'), 'manager API must call dashboard notes tree endpoint');
    assert.ok(api.includes('/api/dashboard/notes/file'), 'manager API must call dashboard notes file endpoint');
    assert.ok(api.includes('/api/dashboard/notes/folder'), 'manager API must call dashboard notes folder endpoint');
    assert.ok(api.includes('/api/dashboard/notes/rename'), 'manager API must call dashboard notes rename endpoint');
    assert.ok(api.includes('/api/dashboard/notes/trash'), 'manager API must call dashboard notes trash endpoint');
    assert.ok(row.includes('Open'), 'manager UI must expose Open action');
    assert.ok(row.includes('props.instance.url'), 'Open must link to instance URL');
    assert.ok(row.includes('props.instance.ok'), 'Open must gate on instance reachability');
    assert.ok(command.includes('Search port, home, CLI, model'), 'manager UI must include search');
});

test('manager command bar exposes polished dashboard brand', () => {
    const command = read('public/manager/src/components/CommandBar.tsx');
    const compact = read('public/manager/src/manager-p0-1-1.css');

    assert.ok(command.includes('CLI-JAW'), 'command bar must render compact CLI-JAW wordmark');
    assert.ok(command.includes('DASH'), 'command bar must render one-line DASH label');
    assert.equal(command.includes('🦈'), false, 'top dashboard brand must not use emoji');
    assert.ok(compact.includes('manager-brand-heading'), 'brand heading must have explicit polish styling');
    assert.ok(compact.includes('manager-brand-dash'), 'DASH label must be styled as secondary context');
    assert.ok(compact.includes('font-weight: 850'), 'brand heading must use stronger typography');
});

test('manager frontend exposes one-instance preview controls', () => {
    const app = read('public/manager/src/App.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');
    const header = read('public/manager/src/components/WorkbenchHeader.tsx');
    const hook = read('public/manager/src/hooks/useDashboardView.ts');
    const themeHook = read('public/manager/src/hooks/useTheme.ts');
    const preview = read('public/manager/src/InstancePreview.tsx');
    const helper = read('public/manager/src/preview.ts');
    const childTheme = read('public/js/features/theme.ts');
    const childHtml = read('public/index.html');
    const components = read('public/manager/src/manager-components.css');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const settingsShell = read('public/manager/src/settings/SettingsShell.tsx');

    assert.ok(hook.includes('selectedPort'), 'manager UI must track a selected preview instance');
    assert.ok(app.includes('handleSelectInstance'), 'manager UI must allow selecting any instance row');
    assert.ok(app.includes('InstancePreview'), 'manager UI must render preview component');
    assert.ok(app.includes('refreshInstance'), 'manager UI must refresh one selected instance without a full page reload');
    assert.ok(app.includes('fetchInstanceStatus(port)'), 'selected refresh must use the single-instance status endpoint');
    assert.equal(workbench.includes('contentByMode'), false, 'workbench must not unmount preview through contentByMode switching');
    assert.ok(workbench.includes('workbench-panel-preview'), 'workbench must render preview in a dedicated panel');
    assert.ok(workbench.includes("hidden={props.mode !== 'preview'}"), 'preview panel must hide without unmounting across tab changes');
    assert.ok(workbench.includes('data-preview-host="persistent"'), 'preview host must be explicitly persistent');
    assert.ok(workbench.includes('{props.preview}'), 'persistent preview panel must render the preview slot');
    assert.ok(header.includes('role="switch"'), 'workbench header must expose a compact preview on/off switch');
    assert.ok(header.includes('onPreviewRefresh'), 'workbench header must expose iframe preview refresh');
    assert.ok(app.includes('previewRefreshKey'), 'App must track a preview refresh key');
    assert.ok(app.includes('function WorkspaceSurface'), 'App must wrap top-level workspaces in persistent surfaces');
    assert.ok(app.includes('workspace-surface-stack'), 'App must keep the top-level workspace stack mounted across sidebar mode changes');
    assert.ok(app.includes('workspace-surface-layer'), 'App must separate persistent workspace surfaces from lifecycle messages');
    assert.ok(app.includes("<WorkspaceSurface active={view.sidebarMode === 'instances'}>"), 'Instances workbench must hide without unmounting across sidebar mode changes');
    assert.ok(app.includes("<WorkspaceSurface active={view.sidebarMode === 'notes'}>"), 'Notes workspace must hide without unmounting across sidebar mode changes');
    assert.ok(app.includes("<WorkspaceSurface active={view.sidebarMode === 'settings'}>"), 'Dashboard settings workspace must hide without unmounting across sidebar mode changes');
    assert.ok(app.includes('hidden={!props.active}'), 'inactive persistent workspace surfaces must use hidden instead of conditional unmounting');
    assert.ok(app.includes('theme.resolved'), 'App must pass the concrete resolved dashboard theme to preview');
    assert.ok(app.includes('theme.syncFromRegistry'), 'App must hydrate registry theme through hook state');
    assert.ok(themeHook.includes('syncFromRegistry'), 'theme hook must expose registry sync that updates React state');
    assert.ok(themeHook.includes('setThemeState(next)'), 'registry theme sync must update React state');
    assert.ok(preview.includes('props.enabled'), 'InstancePreview must obey the header preview on/off switch');
    assert.ok(preview.includes('props.refreshKey'), 'InstancePreview must remount the iframe when refreshed');
    assert.equal(preview.includes('sidebarMode'), false, 'InstancePreview iframe key must not include sidebarMode');
    assert.ok(preview.includes('jaw-preview-theme-sync'), 'InstancePreview must post dashboard theme to iframe');
    assert.ok(preview.includes('previewTargetOrigin(src, frame)'), 'InstancePreview must target the actual iframe origin when readable');
    assert.ok(preview.includes("actualOrigin !== 'null'"), 'InstancePreview must skip opaque about:blank origins');
    assert.ok(preview.includes("expectedOrigin === 'null' ? null : expectedOrigin"), 'InstancePreview must not call postMessage with target origin null');
    assert.ok(preview.includes('postPreviewTheme(iframeRef.current, state.src, props.theme)'), 'InstancePreview must route theme sync through guarded postMessage helper');
    assert.ok(preview.includes("console.warn('[manager-preview] theme sync skipped'"), 'InstancePreview must not let origin mismatch postMessage errors break the dashboard');
    assert.equal(preview.includes("postMessage(\n            { type: 'jaw-preview-theme-sync', theme: props.theme },\n            '*',"), false, 'InstancePreview must not post preview theme with wildcard origin');
    assert.ok(helper.includes('PreviewTheme'), 'preview helper must type dark/light preview themes');
    assert.ok(helper.includes('jawTheme'), 'preview helper must append jawTheme query');
    assert.ok(helper.includes("PreviewTransport = 'origin-port' | 'legacy-path' | 'none'"), 'preview helper must not expose direct transport');
    assert.ok(childHtml.includes('jawTheme'), 'child Web UI first-paint bootstrap must read jawTheme');
    assert.ok(childTheme.includes('jaw-preview-theme-sync'), 'child Web UI must listen for preview theme sync messages');
    assert.ok(childTheme.includes('event.source !== window.parent'), 'child Web UI must only accept theme messages from parent frame');
    assert.ok(childTheme.includes('isLocalThemeOrigin'), 'child Web UI must validate local/same origins');
    assert.ok(childTheme.includes('applyTheme(data.theme)'), 'child Web UI must apply preview theme without using the persistent toggle path');
    assert.equal(childTheme.includes("localStorage.setItem(STORAGE_KEY, data.theme"), false, 'preview message theme changes must not persist to localStorage');
    assert.ok(detail.includes('onSettingsSaved'), 'settings save must notify the detail host');
    assert.ok(settingsShell.includes('onSaved?.()'), 'SettingsShell must emit a save-complete callback');
    assert.ok(components.includes('.workbench-panel'), 'workbench panels must have stable sizing');
    assert.ok(components.includes('.workbench-panel[hidden]'), 'inactive persistent preview panel must not reserve space');
    const layout = read('public/manager/src/manager-layout.css');
    assert.ok(layout.includes('.workspace-surface-stack'), 'layout CSS must size the persistent workspace stack');
    assert.ok(layout.includes('.workspace-surface-layer'), 'layout CSS must size the persistent workspace layer');
    assert.ok(layout.includes('.workspace-surface[hidden]'), 'hidden workspace surfaces must not reserve visible space');
    assert.ok(components.includes('.preview-switch'), 'preview switch must have compact header styling');
    assert.ok(components.includes('.preview-refresh-button'), 'preview refresh button must have compact header styling');
    assert.ok(preview.includes('<iframe'), 'preview component must mount iframe');
    assert.ok(preview.includes('clipboard-read; clipboard-write'), 'preview iframe must explicitly allow clipboard read/write');
    assert.ok(header.includes('preview-inline-status'), 'workbench header must expose compact preview status');
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
    assert.equal(
        hook.includes('Date.parse(latest) <= Date.parse(seenActivityAt)'),
        false,
        'markPortSeen must NOT short-circuit on the global seen ceiling — per-port suppression is independent (devlog 260501)',
    );
    assert.ok(app.includes('activitySeenAt'), 'App must hydrate/persist activitySeenAt through registry UI');
    assert.ok(app.includes('activitySeenByPort'), 'App must hydrate/persist per-port activity seen state');
    assert.equal(
        hook.includes('if (!options.activityDockCollapsed) return {}'),
        false,
        'opening the Activity dock must NOT wipe per-port badges for other ports (devlog 260501)',
    );
    assert.ok(hook.includes('activePreviewPort'), 'activity unread hook must accept the currently-viewed iframe port to suppress its own badge only');
    assert.ok(app.includes('activityUnread.unreadByPort'), 'App must pass per-port unread counts into instance groups');
    assert.ok(app.includes('useInstanceMessageEvents(instances)'), 'App must poll instance messages without dashboard refresh');
    assert.ok(app.includes('activityUnread.markPortSeen'), 'App must mark the selected instance as seen when clicked');
    assert.equal(
        app.includes('messageActivity.events, managerEvents.events, selectedInstance, view.activeDetailTab, view.selectedPort'),
        false,
        'new message events must not auto-clear sidebar unread badges while Preview is selected',
    );
    assert.ok(app.includes('onToggleActivity={activityUnread.openAndMarkSeen}'), 'mobile Activity open path must mark events as seen');
    assert.ok(types.includes('activitySeenAt: string | null'), 'frontend registry UI type must include activitySeenAt');
    assert.ok(types.includes('activitySeenByPort: Record<string, string>'), 'frontend registry UI type must include per-port seen state');
    assert.ok(groups.includes('activityUnreadByPort'), 'InstanceGroups must accept per-port unread counts');
    assert.ok(row.includes('activityUnreadCount'), 'InstanceRow must accept unread count');
    assert.ok(row.includes('onMarkActivitySeen'), 'InstanceRow must clear the clicked instance unread count');
    assert.ok(row.includes('instance-unread-badge'), 'InstanceRow must render the compact row badge');
    assert.ok(row.includes('99+'), 'InstanceRow badge must cap large counts');
    assert.ok(rail.includes('aria-label="Instances"'), 'SidebarRail must expose the Instances workspace mode');
    assert.ok(rail.includes('aria-label="Notes"'), 'SidebarRail must expose the Notes workspace mode');
    assert.ok(rail.includes("onModeChange('settings')"), 'SidebarRail must switch to Dashboard settings mode');
    assert.ok(rail.includes('aria-label="Dashboard settings"'), 'SidebarRail must expose Dashboard settings without duplicating Workbench Settings');
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

test('manager lifecycle message can be dismissed', () => {
    const app = read('public/manager/src/App.tsx');
    const components = read('public/manager/src/manager-components.css');

    assert.ok(app.includes('className="state lifecycle-state"'), 'lifecycle message must keep its status banner styling');
    assert.ok(app.includes('aria-label="Dismiss lifecycle message"'), 'lifecycle message must expose a dismiss button');
    assert.ok(app.includes('onClick={() => setLifecycleMessage(null)}'), 'dismiss button must clear lifecycleMessage');
    assert.ok(components.includes('.state-dismiss'), 'dismiss button must have dedicated compact styling');
    assert.ok(components.includes('overflow-wrap: anywhere'), 'long lifecycle errors must wrap inside the banner');
});

test('manager instance rows support custom labels and latest activity titles', () => {
    const app = read('public/manager/src/App.tsx');
    const list = read('public/manager/src/components/InstanceListContent.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const labelHook = read('public/manager/src/hooks/useInstanceLabelEditor.ts');
    const messageHook = read('public/manager/src/hooks/useInstanceMessageEvents.ts');
    const server = read('server.ts');
    const db = read('src/core/db.ts');
    const latestRoute = server.slice(
        server.indexOf("app.get('/api/messages/latest'"),
        server.indexOf("app.get('/api/runtime'"),
    );

    assert.ok(app.includes('useInstanceLabelEditor'), 'App must use a focused hook for custom label persistence');
    assert.ok(app.includes('messageActivity.titlesByPort'), 'App must pass latest activity titles into the instance list');
    assert.ok(app.includes('messageActivity.titleSupportByPort'), 'App must summarize latest-title endpoint support by instance');
    assert.ok(app.includes('messageActivity.events'), 'App must keep message events in the unread derivation');
    assert.ok(list.includes('latestTitleByPort'), 'InstanceListContent must accept latest title map');
    assert.ok(list.includes('showLatestActivityTitles'), 'InstanceListContent must accept latest title visibility preference');
    assert.ok(list.includes('showInlineLabelEditor'), 'InstanceListContent must accept label editor visibility preference');
    assert.ok(list.includes('showSidebarRuntimeLine'), 'InstanceListContent must accept runtime line visibility preference');
    assert.ok(list.includes('showSelectedRowActions'), 'InstanceListContent must accept selected action visibility preference');
    assert.ok(list.includes('onInstanceLabelSave'), 'InstanceListContent must accept custom label save callback');
    assert.ok(groups.includes('latestActivityTitle={props.latestTitleByPort?.[instance.port] || null}'), 'InstanceGroups must attach titles to matching ports');
    assert.ok(groups.includes('onInstanceLabelSave={props.onInstanceLabelSave}'), 'InstanceGroups must forward label save callback');
    assert.ok(row.includes('instance-label-edit-button'), 'InstanceRow must expose a rename affordance');
    assert.ok(row.includes('instance-label-edit-form'), 'InstanceRow must render inline label edit form');
    assert.ok(row.includes('props.instance.label || props.profile?.label || props.label'), 'explicit instance labels must override profile/generated labels');
    assert.ok(row.includes('instance-row-activity-title'), 'InstanceRow must render a one-line latest activity title');
    assert.ok(labelHook.includes("instances: { [String(port)]: { label: nextLabel } }"), 'label save must patch the registry instance entry');
    assert.ok(labelHook.includes('label?.trim() || null'), 'blank label must clear to fallback');
    assert.ok(messageHook.includes('InstanceMessageActivityState'), 'message hook must return both unread events and titles');
    assert.ok(messageHook.includes('titlesByPort'), 'message hook must derive titles by port');
    assert.ok(messageHook.includes('titleSupportByPort'), 'message hook must expose per-port title support status');
    assert.ok(messageHook.includes("nextSupport[instance.port] = 'offline'"), 'message hook must clear title support for offline instances');
    assert.ok(messageHook.includes('latestAssistantFromEnvelope'), 'message hook must preserve legacy assistant unread baseline');
    assert.ok(messageHook.includes('notifiableAssistantFromEnvelope'), 'message hook must wait for assistant activity before unread notification on new endpoint envelopes');
    assert.ok(latestRoute.includes("app.get('/api/messages/latest'"), 'backend must extend the existing latest endpoint');
    assert.ok(latestRoute.includes('latestAssistant'), 'latest endpoint must preserve latest assistant field');
    assert.ok(latestRoute.includes('activity:'), 'latest endpoint must include latest activity title payload');
    assert.ok(db.includes('substr(content, 1, 240) AS excerpt'), 'latest activity query must fetch only a bounded content excerpt');
    assert.equal(latestRoute.includes('getMessages.all()'), false, 'latest endpoint must not fetch full message history');
});

test('manager workbench modes remain instance-only while Notes renders outside Workbench', () => {
    const app = read('public/manager/src/App.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');

    assert.ok(app.includes('NotesWorkspace'), 'App must render the Notes workspace');
    assert.ok(app.includes('DashboardSettingsWorkspace'), 'App must render Dashboard settings outside Workbench');
    assert.ok(app.includes("view.sidebarMode === 'notes'"), 'Notes must be selected by workspace mode, not a Workbench tab');
    assert.ok(app.includes("view.sidebarMode === 'settings'"), 'Dashboard settings must be selected by workspace mode, not a Workbench tab');
    assert.ok(workbench.includes("const MODES: DashboardDetailTab[] = ['overview', 'preview', 'logs', 'settings']"), 'Workbench tabs must stay Overview/Preview/Logs/Settings only');
    assert.equal(workbench.includes("'notes'"), false, 'Workbench must not add Notes as a detail tab');
    assert.ok(app.includes('notesSelectedPath'), 'App must hydrate and persist selected note path');
    assert.ok(app.includes('notesViewMode'), 'App must hydrate and persist Notes view mode');
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
    assert.ok(main.includes('./manager-p0-1-1.css'), 'P0-1.1 compact manager CSS must stay loaded');
    assert.ok(main.includes('./manager-dashboard-settings.css'), 'dashboard settings styling must be split into its own CSS module');
    assert.ok(
        main.indexOf('./manager-p0-1-1.css') < main.indexOf('./manager-dashboard-settings.css'),
        'dashboard settings CSS may layer after compact row polish',
    );
    assert.ok(compact.includes('.manager-sidebar .instance-row-version'), 'sidebar polish must hide secondary row metadata in compact mode');
    assert.ok(compact.includes('.manager-sidebar .instance-actions'), 'sidebar polish must control action-row density');
    assert.ok(compact.includes('.manager-shell.is-sidebar-collapsed .manager-workspace'), 'sidebar collapse must reclaim detail width');
});

test('manager dashboard settings workspace controls sidebar display preferences', () => {
    const app = read('public/manager/src/App.tsx');
    const view = read('public/manager/src/hooks/useDashboardView.ts');
    const registry = read('src/manager/registry.ts');
    const workspace = read('public/manager/src/dashboard-settings/DashboardSettingsWorkspace.tsx');
    const sidebar = read('public/manager/src/dashboard-settings/DashboardSettingsSidebar.tsx');
    const helper = read('public/manager/src/dashboard-settings/activity-title-support.ts');
    const css = read('public/manager/src/manager-dashboard-settings.css');
    const types = read('public/manager/src/types.ts');
    const api = read('public/manager/src/api.ts');

    assert.ok(app.includes('dashboardSettingsUiFromView'), 'App must derive settings UI from live view state');
    assert.ok(app.includes('handleDashboardSettingsPatch'), 'App must patch dashboard settings through registry UI');
    assert.ok(view.includes('showLatestActivityTitles'), 'view hook must own latest title visibility');
    assert.ok(view.includes('showInlineLabelEditor'), 'view hook must own inline label editor visibility');
    assert.ok(view.includes('showSidebarRuntimeLine'), 'view hook must own runtime line visibility');
    assert.ok(view.includes('showSelectedRowActions'), 'view hook must own selected row action visibility');
    assert.ok(registry.includes("'settings'"), 'registry sidebar mode must support Dashboard settings mode');
    assert.ok(registry.includes('showLatestActivityTitles: true'), 'registry defaults must enable latest activity titles');
    assert.ok(types.includes("DashboardActivityTitleSupportStatus = 'ready' | 'legacy' | 'offline'"), 'frontend types must name latest-title support states');
    assert.equal(workspace.includes('ToggleField'), false, 'dashboard settings must not reuse the instance settings toggle layout');
    assert.ok(workspace.includes('Instance list display'), 'settings workspace must clarify the affected surface');
    assert.ok(workspace.includes('Recent activity preview'), 'settings workspace must expose latest title toggle with clear copy');
    assert.ok(workspace.includes('Rename control'), 'settings workspace must expose label editor toggle with clear copy');
    assert.ok(workspace.includes('Runtime line'), 'settings workspace must expose runtime line toggle with clear copy');
    assert.ok(workspace.includes('Expanded row actions'), 'settings workspace must expose selected actions toggle with clear copy');
    assert.ok(workspace.includes('Left instance list'), 'settings workspace must show setting scope labels');
    assert.ok(workspace.includes('Language'), 'settings workspace must expose a saved language menu');
    assert.ok(workspace.includes('인스턴스 목록 표시'), 'settings workspace must render Korean copy when locale=ko');
    assert.ok(workspace.includes('최근 작업 미리보기'), 'settings workspace must localize row labels');
    assert.ok(workspace.includes('언어'), 'settings workspace must localize the language row');
    assert.ok(workspace.includes('LOCALE_OPTIONS'), 'settings workspace must define supported locale options');
    assert.ok(sidebar.includes('사이드바 행'), 'settings sidebar must render Korean section copy when locale=ko');
    assert.ok(app.includes('locale={view.locale}'), 'settings sidebar must receive the saved dashboard locale');
    assert.ok(workspace.includes("props.onUiPatch({ locale: next })"), 'settings workspace must save dashboard locale through manager registry UI');
    assert.equal(workspace.includes('fetchDashboardRuntimeSettings'), false, 'manager dashboard must not call missing root /api/settings for locale');
    assert.equal(workspace.includes('updateDashboardRuntimeSettings'), false, 'manager dashboard must not PUT missing root /api/settings for locale');
    assert.ok(workspace.includes('TitleSupportSummary'), 'settings workspace must summarize endpoint readiness');
    assert.ok(sidebar.includes('Sidebar rows'), 'settings sidebar must include display settings section');
    assert.ok(helper.includes('summarizeActivityTitleSupport'), 'support helper must aggregate per-port support status');
    assert.equal(api.includes("fetch('/api/settings'"), false, 'manager API must not call unavailable root settings routes from dashboard mode');
    assert.ok(css.includes('.dashboard-settings-workspace'), 'settings CSS must use dashboard-settings prefix');
    assert.ok(css.includes('.dashboard-settings-row'), 'settings CSS must align each setting in a scoped row');
    assert.ok(css.includes('.dashboard-settings-select'), 'settings CSS must style dashboard language select');
    assert.equal(css.includes('.settings-workspace'), false, 'settings CSS must not collide with existing settings-shell prefix');
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
    const list = read('public/manager/src/components/InstanceListContent.tsx');

    assert.equal(app.includes('renderInstanceListContent(true)'), false, 'selected instance must remain in the grouped list after removing duplicate active card');
    assert.equal(app.includes('filtered.filter(instance => instance.port !== selectedInstance.port)'), false, 'App must not remove selected instances from sidebar groups');
    assert.ok(list.includes('[props.selectedInstance, ...props.filtered]'), 'extracted instance list must keep selected instances visible even when filters exclude them');
    assert.equal(navigator.includes('InstanceRow'), false, 'InstanceNavigator must not render a second selected instance card');
});

test('manager profile rows keep Active/Running grouping while merging profile labels into rows', () => {
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const components = read('public/manager/src/manager-components.css');
    const compact = read('public/manager/src/manager-p0-1-1.css');

    assert.equal(groups.includes("import { ProfileSection }"), false, 'profile groups must not render a separate profile header card');
    assert.ok(groups.includes('is-profile-merged'), 'profile instance groups must expose merged-row styling');
    assert.ok(groups.includes("label: 'Active'"), 'profile merged sidebar must preserve the Active group header');
    assert.ok(groups.includes("label: 'Running'"), 'profile merged sidebar must preserve the Running group header');
    assert.equal(groups.includes('selected.forEach(instance => used.add(instance.port))'), false, 'selected active/running rows must remain in their original Running group');
    assert.ok(groups.includes('profileMap.get(instance.profileId)'), 'profile context must be resolved per grouped instance row');
    assert.ok(groups.includes('profile={profile}'), 'profile context must be forwarded into the row');
    assert.equal(groups.includes('No online instances for this profile.'), false, 'sidebar must not replace instance groups with profile-empty cards');
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
    assert.ok(app.includes('InstanceListContent'), 'App must render grouped instance list through extracted content');
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
    assert.ok(app.includes('effectiveProfileIds'), 'App must ignore stale profile filters that are absent from the current scan');
    assert.ok(app.includes('known.has(profileId)'), 'App must derive profile filtering from currently visible profile ids');
    assert.ok(groups.includes('is-profile-merged'), 'InstanceGroups must merge profile sections into instance rows');
    assert.ok(drawer.includes('drawer-profile-filters'), 'mobile drawer must mirror profile filters');
    assert.ok(main.includes('./manager-profiles.css'), 'profile styling must stay split from large CSS files');
});

test('board overall view limits done preview and exposes lane detail navigation', () => {
    const app = read('public/manager/src/App.tsx');
    const sidebar = read('public/manager/src/dashboard-board/DashboardBoardSidebar.tsx');
    const workspace = read('public/manager/src/dashboard-board/DashboardBoardWorkspace.tsx');
    const detail = read('public/manager/src/dashboard-board/BoardLaneDetailView.tsx');

    assert.ok(app.includes('boardView'), 'App must own Board view state');
    assert.ok(sidebar.includes('Overall'), 'Board sidebar must expose Overall navigation');
    assert.ok(workspace.includes('DONE_PREVIEW_LIMIT'), 'Board workspace must cap Done preview count');
    assert.ok(workspace.includes("onViewChange({ kind: 'lane', lane: 'done' })"), 'Done more action must open Done lane detail');
    assert.ok(detail.includes('dashboard-board-compact-row'), 'Lane detail must render compact rows');
});
