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
    assert.ok(row.includes('Open'), 'manager UI must expose Open action');
    assert.ok(command.includes('Search port, home, CLI, model'), 'manager UI must include search');
});

test('manager frontend exposes one-instance preview controls', () => {
    const app = read('public/manager/src/App.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const hook = read('public/manager/src/hooks/useDashboardView.ts');
    const preview = read('public/manager/src/InstancePreview.tsx');
    const helper = read('public/manager/src/preview.ts');

    assert.ok(hook.includes('selectedPort'), 'manager UI must track a selected preview instance');
    assert.ok(app.includes('handleSelectInstance'), 'manager UI must allow selecting any instance row');
    assert.ok(detail.includes('InstancePreview'), 'manager UI must render preview component');
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
    const command = read('public/manager/src/components/CommandBar.tsx');
    const types = read('public/manager/src/types.ts');

    assert.ok(types.includes('DashboardLifecycleCapability'), 'frontend types must include lifecycle capability');
    assert.ok(types.includes("'manager'"), 'frontend service mode must represent manager-owned instances');
    assert.ok(command.includes('Custom home, default ~/.cli-jaw-<port>'), 'manager UI must expose custom home policy');
    assert.ok(app.includes('handleLifecycle'), 'manager UI must keep lifecycle controller');
    assert.ok(row.includes("onLifecycle('start'"), 'manager UI must expose Start action');
    assert.ok(row.includes("onLifecycle('stop'"), 'manager UI must expose Stop action');
    assert.ok(row.includes("onLifecycle('restart'"), 'manager UI must expose Restart action');
    assert.ok(row.includes('Preview'), 'manager UI must keep Preview action');
    assert.ok(row.includes('Open'), 'manager UI must keep Open action');
});

test('manager instance rows are selectable independently from preview availability', () => {
    const app = read('public/manager/src/App.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');

    assert.ok(row.includes('className="instance-row-select"'), 'instance row body must expose a dedicated select control');
    assert.ok(row.includes('type="button"'), 'instance row selection must be button-based and keyboard reachable');
    assert.ok(row.includes('onSelect(props.instance)'), 'row click/key must select the row instance');
    assert.ok(groups.includes('onSelect={props.onSelect}'), 'group list must forward row selection');
    assert.ok(app.includes("view.setActiveDetailTab('overview')"), 'row selection must switch detail to overview');
    assert.ok(app.includes('view.setDrawerOpen(false)'), 'row selection must close the mobile drawer');
});

test('manager frontend routes layout through responsive shell components', () => {
    const app = read('public/manager/src/App.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');

    assert.ok(app.includes('ManagerShell'), 'App must use ManagerShell after 10.5.2 extraction');
    assert.ok(app.includes('CommandBar'), 'App must render CommandBar');
    assert.ok(app.includes('InstanceGroups'), 'App must render grouped instance list');
    assert.ok(app.includes('ActivityDock'), 'App must render ActivityDock');
    assert.ok(detail.includes("'overview'"), 'detail panel must expose Overview tab');
    assert.ok(detail.includes("'preview'"), 'detail panel must expose Preview tab');
    assert.ok(detail.includes("'logs'"), 'detail panel must expose Logs tab');
    assert.ok(detail.includes("'settings'"), 'detail panel must expose Settings tab');
});
