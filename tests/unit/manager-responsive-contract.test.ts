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

function cssBlock(css: string, mediaQuery: string): string {
    const start = css.indexOf(mediaQuery);
    assert.notEqual(start, -1, `${mediaQuery} media query must exist`);

    let depth = 0;
    let blockStart = -1;
    for (let index = start; index < css.length; index += 1) {
        const char = css[index];
        if (char === '{') {
            depth += 1;
            if (blockStart === -1) {
                blockStart = index + 1;
            }
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0 && blockStart !== -1) {
                return css.slice(blockStart, index);
            }
        }
    }

    assert.fail(`${mediaQuery} media query must be closed`);
}

test('manager responsive components exist', () => {
    [
        'ManagerShell',
        'WorkspaceLayout',
        'Workbench',
        'SidebarRail',
        'CommandCenter',
        'CommandFilters',
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
    assert.ok(css.includes('grid-template-rows: max-content minmax(0, 1fr)'), 'command row must grow to fit persistence controls');
    assert.ok(css.includes('overflow: hidden'), 'page-level scroll must be disabled');
    assert.ok(css.includes('grid-template-areas: "command" "workspace"'), 'global frame must separate command center from workspace');
    assert.ok(css.includes('grid-template-areas: "sidebar detail" "sidebar activity"'), 'workspace must include a unified sidebar region');
    assert.ok(css.includes('@media (min-width: 1440px)'), 'wide desktop breakpoint must exist');
    assert.ok(css.includes('@media (max-width: 1279px) and (min-width: 1024px)'), 'desktop-sidebar breakpoint must be bounded above tablet');
    assert.ok(css.includes('@media (max-width: 1023px)'), 'tablet breakpoint must exist');
    assert.ok(css.includes('@media (max-width: 767px)'), 'mobile breakpoint must exist');
    assert.ok(css.includes('manager-mobile-nav'), 'mobile nav styling must exist');
    assert.ok(css.includes('drawer-backdrop'), 'drawer styling must exist');
    assert.ok(css.includes('command-primary'), 'command center primary row must exist');
    assert.ok(css.includes('command-secondary'), 'command center secondary row must exist');
    assert.ok(css.includes('command-filter-strip'), 'command filters must have an isolated secondary area');
});

test('manager tablet and mobile breakpoints override desktop sidebar state', () => {
    const css = read('public/manager/src/styles.css');
    const laptop = cssBlock(css, '@media (max-width: 1279px) and (min-width: 1024px)');
    const tablet = cssBlock(css, '@media (max-width: 1023px)');
    const mobile = cssBlock(css, '@media (max-width: 767px)');

    assert.ok(
        laptop.includes('.dashboard-shell.manager-shell:not(.is-sidebar-collapsed) .manager-workspace'),
        'laptop breakpoint may keep desktop sidebar state only at 1024px and above',
    );
    assert.ok(
        tablet.includes('.dashboard-shell.manager-shell:not(.is-sidebar-collapsed) .manager-workspace'),
        'tablet breakpoint must explicitly override the higher-specificity desktop sidebar selector',
    );
    assert.ok(
        tablet.includes('grid-template-columns: minmax(0, 1fr)'),
        'tablet breakpoint must collapse to one full-width column',
    );
    assert.ok(
        mobile.includes('.dashboard-shell.manager-shell:not(.is-sidebar-collapsed) .manager-workspace'),
        'mobile breakpoint must explicitly override the higher-specificity desktop sidebar selector',
    );
    assert.ok(
        mobile.includes('grid-template-columns: 1fr'),
        'mobile breakpoint must not retain a desktop sidebar column',
    );
});

test('manager desktop layout uses one unified sidebar', () => {
    const app = read('public/manager/src/App.tsx');
    const shell = read('public/manager/src/components/ManagerShell.tsx');
    const workspace = read('public/manager/src/components/WorkspaceLayout.tsx');
    const css = read('public/manager/src/styles.css');

    assert.ok(app.includes('<WorkspaceLayout'), 'App must assemble navigator/workbench/inspector through WorkspaceLayout');
    assert.ok(app.includes('navigator={'), 'App must pass one navigator surface to WorkspaceLayout');
    assert.ok(app.includes('sidebarCollapsed={view.sidebarCollapsed}'), 'App must pass sidebar collapse state to ManagerShell');
    assert.ok(app.includes('manager-sidebar-list'), 'App must place instance list inside the unified sidebar');
    assert.equal(shell.includes('manager-rail'), false, 'ManagerShell must not render a separate rail column');
    assert.equal(shell.includes('manager-list'), false, 'ManagerShell must not render a separate list column');
    assert.ok(workspace.includes('manager-sidebar'), 'WorkspaceLayout must render a single sidebar container');
    assert.ok(css.includes('grid-template-areas: "sidebar detail" "sidebar activity"'), 'desktop workspace grid must have one sidebar column');
    assert.ok(css.includes('is-sidebar-collapsed'), 'desktop sidebar must have a collapsed grid state');
    assert.equal(css.includes('grid-area: list'), false, 'CSS must not keep a separate list grid area');
    assert.equal(css.includes('grid-area: rail'), false, 'CSS must not keep a separate rail grid area');
});

test('manager UI state is persisted through 10.6 registry without localStorage', () => {
    const app = read('public/manager/src/App.tsx');
    const hook = read('public/manager/src/hooks/useDashboardView.ts');
    const registryHook = read('public/manager/src/hooks/useDashboardRegistry.ts');
    const drawer = read('public/manager/src/components/InstanceDrawer.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const rail = read('public/manager/src/components/SidebarRail.tsx');

    assert.ok(hook.includes('activeDetailTab'), 'view hook must own detail tab state');
    assert.ok(hook.includes('drawerOpen'), 'view hook must own drawer state');
    assert.ok(hook.includes('activityDockCollapsed'), 'view hook must own activity dock state');
    assert.ok(hook.includes('activityDockHeight'), 'view hook must own runtime-only activity dock height');
    assert.ok(hook.includes('sidebarCollapsed'), 'view hook must own runtime-only sidebar collapse state');
    assert.ok(rail.includes('rail-collapse-button'), 'sidebar rail must expose a collapse button');
    assert.ok(rail.includes('aria-pressed={props.collapsed}'), 'collapse button must expose pressed state');
    assert.ok(drawer.includes("event.key === 'Escape'"), 'drawer must close on Escape');
    assert.ok(drawer.includes('previousFocusRef'), 'drawer must restore focus');
    assert.ok(drawer.includes('role="dialog"'), 'drawer must expose dialog semantics');
    assert.ok(detail.includes('Logs stream is planned for phase 10.7'), 'Logs tab must have explicit empty state');
    assert.ok(detail.includes('settings-form'), 'Settings tab must expose 10.6 persistence controls');
    assert.equal(app.includes('localStorage'), false, '10.5.x UI must not introduce localStorage persistence');
    assert.equal(hook.includes('localStorage'), false, 'view hook must not persist UI state yet');
    assert.equal(registryHook.includes('localStorage'), false, 'registry hook must not use localStorage');
    assert.ok(app.includes('saveUi'), 'App must persist selected UI state through the registry API');
});

test('manager activity dock is vertically resizable', () => {
    const app = read('public/manager/src/App.tsx');
    const shell = read('public/manager/src/components/ManagerShell.tsx');
    const dock = read('public/manager/src/components/ActivityDock.tsx');
    const css = read('public/manager/src/styles.css');

    assert.ok(app.includes('activityHeight={view.activityDockCollapsed ? 48 : view.activityDockHeight}'), 'App must drive shell activity height');
    assert.ok(app.includes('onHeightChange={handleActivityHeight}'), 'App must wire activity resize state');
    assert.ok(shell.includes("'--activity-dock-height'"), 'ManagerShell must expose activity height as CSS variable');
    assert.ok(dock.includes('activity-resize-handle'), 'ActivityDock must render a resize handle');
    assert.ok(dock.includes('pointermove'), 'ActivityDock must handle pointer drag');
    assert.ok(dock.includes('clampActivityHeight'), 'ActivityDock must clamp drag height');
    assert.ok(css.includes('var(--activity-dock-height'), 'CSS grid must use runtime activity height');
    assert.ok(css.includes('cursor: ns-resize'), 'CSS must communicate vertical resizing');
});
