import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('manager responsive components exist', () => {
    [
        'ManagerShell',
        'SidebarRail',
        'CommandBar',
        'InstanceGroups',
        'InstanceRow',
        'InstanceDetailPanel',
        'ActivityDock',
        'MobileNav',
        'InstanceDrawer',
    ].forEach(name => {
        assert.equal(
            existsSync(join(projectRoot, 'public', 'manager', 'src', 'components', `${name}.tsx`)),
            true,
            `${name} component must exist`,
        );
    });
});

test('manager responsive CSS defines shell regions and breakpoints', () => {
    const css = read('public/manager/src/styles.css');

    assert.ok(css.includes('manager-shell'), 'CSS must define manager shell');
    assert.ok(css.includes('grid-template-areas'), 'CSS must use named shell regions');
    assert.ok(css.includes('height: 100dvh'), 'manager shell/root must be viewport-height bounded');
    assert.ok(css.includes('overflow: hidden'), 'page-level scroll must be disabled');
    assert.ok(css.includes('rail command command'), 'wide layout must include rail/list/detail/dock regions');
    assert.ok(css.includes('@media (min-width: 1440px)'), 'wide desktop breakpoint must exist');
    assert.ok(css.includes('@media (max-width: 1279px)'), 'laptop breakpoint must exist');
    assert.ok(css.includes('@media (max-width: 1023px)'), 'tablet breakpoint must exist');
    assert.ok(css.includes('@media (max-width: 767px)'), 'mobile breakpoint must exist');
    assert.ok(css.includes('manager-mobile-nav'), 'mobile nav styling must exist');
    assert.ok(css.includes('drawer-backdrop'), 'drawer styling must exist');
});

test('manager UI state is runtime-only for 10.5.x', () => {
    const app = read('public/manager/src/App.tsx');
    const hook = read('public/manager/src/hooks/useDashboardView.ts');
    const drawer = read('public/manager/src/components/InstanceDrawer.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');

    assert.ok(hook.includes('activeDetailTab'), 'view hook must own detail tab state');
    assert.ok(hook.includes('drawerOpen'), 'view hook must own drawer state');
    assert.ok(hook.includes('activityDockCollapsed'), 'view hook must own activity dock state');
    assert.ok(hook.includes('activityDockHeight'), 'view hook must own runtime-only activity dock height');
    assert.ok(drawer.includes("event.key === 'Escape'"), 'drawer must close on Escape');
    assert.ok(drawer.includes('previousFocusRef'), 'drawer must restore focus');
    assert.ok(drawer.includes('role="dialog"'), 'drawer must expose dialog semantics');
    assert.ok(detail.includes('Logs stream is planned for phase 10.7'), 'Logs tab must have explicit empty state');
    assert.ok(detail.includes('planned for phase 10.6'), 'Settings tab must identify persistence boundary');
    assert.equal(app.includes('localStorage'), false, '10.5.x UI must not introduce localStorage persistence');
    assert.equal(hook.includes('localStorage'), false, 'view hook must not persist UI state yet');
    assert.equal(app.includes('registry'), false, '10.5.x UI must not write registry data');
});

test('manager activity dock is vertically resizable', () => {
    const app = read('public/manager/src/App.tsx');
    const shell = read('public/manager/src/components/ManagerShell.tsx');
    const dock = read('public/manager/src/components/ActivityDock.tsx');
    const css = read('public/manager/src/styles.css');

    assert.ok(app.includes('activityHeight={view.activityDockCollapsed ? 48 : view.activityDockHeight}'), 'App must drive shell activity height');
    assert.ok(app.includes('onHeightChange={view.setActivityDockHeight}'), 'App must wire activity resize state');
    assert.ok(shell.includes("'--activity-dock-height'"), 'ManagerShell must expose activity height as CSS variable');
    assert.ok(dock.includes('activity-resize-handle'), 'ActivityDock must render a resize handle');
    assert.ok(dock.includes('pointermove'), 'ActivityDock must handle pointer drag');
    assert.ok(dock.includes('clampActivityHeight'), 'ActivityDock must clamp drag height');
    assert.ok(css.includes('var(--activity-dock-height'), 'CSS grid must use runtime activity height');
    assert.ok(css.includes('cursor: ns-resize'), 'CSS must communicate vertical resizing');
});
