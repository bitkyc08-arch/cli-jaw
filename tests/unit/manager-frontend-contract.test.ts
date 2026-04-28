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

    assert.ok(hook.includes('selectedPort'), 'manager UI must track a selected preview instance');
    assert.ok(app.includes('handleSelectInstance'), 'manager UI must allow selecting any instance row');
    assert.ok(app.includes('view.setPreviewEnabled(true)'), 'explicit preview action must enable iframe preview');
    assert.ok(app.includes('InstancePreview'), 'manager UI must render preview component');
    assert.ok(workbench.includes('preview: props.preview'), 'workbench must route preview slot content');
    assert.ok(hook.includes('useState(false)'), 'preview iframe must not be enabled by default');
    assert.ok(preview.includes('<iframe'), 'preview component must mount iframe');
    assert.ok(preview.includes('Enable preview'), 'preview component must expose enable toggle');
    assert.ok(preview.includes('Proxy preview'), 'preview component must expose proxy mode');
    assert.ok(preview.includes('Direct iframe'), 'preview component must expose direct mode');
    assert.ok(helper.includes('buildPreviewState'), 'preview helper must centralize URL state');
    assert.ok(helper.includes('/i'), 'preview helper must support manager proxy base path');
});

test('manager frontend exposes lifecycle controls without hiding discovery actions', () => {
    const app = read('public/manager/src/App.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const commandFilters = read('public/manager/src/components/CommandFilters.tsx');
    const types = read('public/manager/src/types.ts');

    assert.ok(types.includes('DashboardLifecycleCapability'), 'frontend types must include lifecycle capability');
    assert.ok(types.includes("'manager'"), 'frontend service mode must represent manager-owned instances');
    assert.ok(commandFilters.includes('Custom home, default ~/.cli-jaw-<port>'), 'manager UI must expose custom home policy');
    assert.ok(app.includes('handleLifecycle'), 'manager UI must keep lifecycle controller');
    assert.ok(row.includes("onLifecycle('start'"), 'manager UI must expose Start action');
    assert.ok(row.includes("onLifecycle('stop'"), 'manager UI must expose Stop action');
    assert.ok(row.includes("onLifecycle('restart'"), 'manager UI must expose Restart action');
    assert.ok(row.includes('Preview'), 'manager UI must keep Preview action');
    assert.ok(row.includes('Open'), 'manager UI must keep Open action');
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
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const command = read('public/manager/src/components/CommandBar.tsx');
    const main = read('public/manager/src/main.tsx');

    assert.ok(hook.includes('patchDashboardRegistry'), 'registry hook must save dashboard registry patches');
    assert.ok(app.includes('useDashboardRegistry'), 'App must hydrate and save registry state');
    assert.ok(detail.includes('Pin favorite'), 'Settings tab must expose favorite pinning');
    assert.ok(detail.includes('Hide by default'), 'Settings tab must expose hidden state');
    assert.ok(groups.includes("id: 'active'"), 'InstanceGroups must keep active row in a top group');
    assert.ok(groups.includes("id: 'favorites'"), 'InstanceGroups must keep pinned favorites near the top');
    assert.ok(command.includes('onScanRangeCommit'), 'CommandBar must support committed scan range changes');
    assert.ok(main.includes('./manager-persistence.css'), 'manager persistence styling must be split into its own CSS module');
});

test('manager frontend exposes 10.8 profile controls', () => {
    const app = read('public/manager/src/App.tsx');
    const filters = read('public/manager/src/components/CommandFilters.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const drawer = read('public/manager/src/components/InstanceDrawer.tsx');
    const main = read('public/manager/src/main.tsx');

    assert.ok(existsSync(join(projectRoot, 'public/manager/src/components/ProfileChip.tsx')), 'ProfileChip must exist');
    assert.ok(existsSync(join(projectRoot, 'public/manager/src/components/ProfileSection.tsx')), 'ProfileSection must exist');
    assert.ok(filters.includes('profile-chip-strip'), 'CommandFilters must expose profile chips');
    assert.ok(app.includes('activeProfileIds'), 'App must own active profile filter state');
    assert.ok(app.includes('activeProfileFilter'), 'App must persist active profile filters through registry');
    assert.ok(groups.includes('ProfileSection'), 'InstanceGroups must render profile sections');
    assert.ok(drawer.includes('drawer-profile-filters'), 'mobile drawer must mirror profile filters');
    assert.ok(main.includes('./manager-profiles.css'), 'profile styling must stay split from large CSS files');
});
