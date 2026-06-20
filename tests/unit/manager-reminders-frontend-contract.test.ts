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

test('manager frontend exposes Reminders as a gated SidebarRail workspace', () => {
    const types = read('public/manager/src/types.ts');
    const features = read('public/manager/src/dashboard-features.ts');
    const rail = read('public/manager/src/components/SidebarRail.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const app = read('public/manager/src/App.tsx');
    const appChrome = read('public/manager/src/AppChrome.tsx');
    const urlState = read('public/manager/src/dashboard-url-state.ts');
    const trayApp = read('public/manager/src/dashboard-reminders/TrayRemindersApp.tsx');
    const serverTypes = read('src/manager/types.ts');
    const registry = read('src/manager/registry.ts');
    const main = read('public/manager/src/main.tsx');
    const sidebar = read('public/manager/src/dashboard-reminders/DashboardRemindersSidebar.tsx');
    const workspace = read('public/manager/src/dashboard-reminders/DashboardRemindersWorkspace.tsx');
    const remindersApi = read('public/manager/src/dashboard-reminders/reminders-api.ts');
    const remindersFeed = read('public/manager/src/dashboard-reminders/useRemindersFeed.ts');

    assert.ok(types.includes("'reminders'"), 'DashboardSidebarMode must include reminders');
    assert.ok(serverTypes.includes("'reminders'"), 'server DashboardSidebarMode must include reminders');
    assert.ok(registry.includes("'reminders'"), 'server registry allowlist must preserve reminders sidebar mode');
    assert.ok(features.includes('REMINDERS_WORKSPACE_ENABLED = true'), 'Reminders workspace must always be available in SidebarRail');
    assert.doesNotMatch(features, /NPM_HIDDEN_WORKSPACE_MODES[^\n]+reminders/, 'Reminders must not be hidden behind the npm workspace gate');
    assert.ok(rail.includes('remindersWorkspaceEnabled'), 'SidebarRail must receive the reminders feature gate');
    assert.ok(rail.includes("onModeChange('reminders')"), 'SidebarRail must switch to reminders mode');
    assert.ok(rail.includes('aria-label="Reminders"'), 'SidebarRail must expose an accessible Reminders button');
    assert.ok(router.includes('<DashboardRemindersSidebar'), 'router must render the reminders sidebar');
    assert.ok(router.includes('<DashboardRemindersWorkspace'), 'router must render the reminders workspace');
    assert.ok(app.includes('<AppChrome'), 'App must delegate dashboard chrome out of the root shell');
    assert.ok(app.includes('readTrayRemindersMode(window.location.search)'), 'App must allow compact tray URL entry');
    assert.ok(app.includes('<TrayRemindersApp />'), 'Tray mode must bypass dashboard chrome');
    assert.ok(appChrome.includes('<SidebarRailRouter'), 'AppChrome must delegate workspace routing out of the root shell');
    assert.ok(app.includes('readInitialSidebarMode(window.location.search)'), 'App must allow sidebar URL entry');
    assert.ok(urlState.includes("'reminders'"), 'URL sidebar parser must allow reminders');
    assert.ok(urlState.includes('readTrayRemindersMode'), 'URL parser must expose tray mode');
    assert.ok(main.includes('./manager-dashboard-reminders.css'), 'Reminders CSS must be loaded by the manager entry');
    assert.ok(main.includes('./manager-dashboard-reminders-priority.css'), 'Reminders priority CSS must be loaded by the manager entry');
    assert.ok(main.includes('./manager-dashboard-reminders-parity.css'), 'Reminders parity CSS must be loaded by the manager entry');
    assert.ok(main.includes('./manager-tray-reminders.css'), 'Tray reminders CSS must be loaded by the manager entry');
    assert.ok(sidebar.includes('countRemindersView'), 'Reminders sidebar counts must use the shared view model');
    assert.ok(trayApp.includes('buildTrayTriageSections'), 'Tray reminders app must use the shared triage helper');
    assert.ok(trayApp.includes('getDesktop()?.trayReminders?.popUpMenu()'), 'Tray reminders app must use the typed desktop bridge for menu access');
    assert.ok(trayApp.includes('aria-label="Mark done"'), 'Tray reminders rows must expose an accessible done action');
    assert.ok(trayApp.includes('aria-label="Snooze reminder"'), 'Tray reminders rows must expose a snooze menu');
    assert.ok(trayApp.includes('feed.markDone(id)'), 'Tray reminders done action must call the feed helper');
    assert.ok(trayApp.includes('pollWhileActiveMs: 30000'), 'Tray reminders app must enable active polling');
    assert.ok(trayApp.includes('feed.markDone(id).then(() => feed.refresh())'), 'Tray reminders done action must refresh after completion');
    assert.ok(trayApp.includes('feed.snooze(id, nextRemindAt).then(() => feed.refresh())'), 'Tray reminders snooze action must refresh after completion');
    assert.ok(sidebar.includes('PrioritySidebarList'), 'Reminders sidebar must expose draggable manual priority ordering');
    assert.ok(sidebar.includes('manualRank'), 'Reminders sidebar drag must persist manualRank updates');
    assert.ok(remindersApi.includes('assertManualRankSupport'), 'manualRank PATCH must fail visibly when the running backend is stale');
    assert.ok(remindersApi.includes("return await updateReminder(id, { status: 'done' })"), 'mark done helper must PATCH status done');
    assert.ok(remindersApi.includes('return await updateReminder(id, { remindAt: nextRemindAt })'), 'snooze helper must PATCH remindAt only');
    assert.ok(remindersFeed.includes('markDone: (id: string) => Promise<void>'), 'feed must expose markDone');
    assert.ok(remindersFeed.includes('snooze: (id: string, nextRemindAt: string) => Promise<void>'), 'feed must expose snooze');
    assert.ok(remindersFeed.includes('pollWhileActiveMs?: number'), 'feed must keep active polling opt-in');
    assert.ok(remindersFeed.includes("window.addEventListener('focus', refreshIfVisible)"), 'feed must refresh on focus when active polling is enabled');
    assert.ok(remindersFeed.includes("document.addEventListener('visibilitychange', refreshIfVisible)"), 'feed must refresh on visibility gain when active polling is enabled');
    assert.ok(router.includes('onUpdate={(id, patch) => void remindersFeed.update(id, patch)}'), 'Reminders sidebar must receive update wiring');
    assert.ok(workspace.includes('InlineReminderTitle'), 'Reminders rows must support double-click inline title editing');
    assert.ok(workspace.includes('data-reminder-drop-before-id'), 'Reminders row drop targets must expose before/after order metadata');
    assert.ok(workspace.includes('isAfterRowDrop'), 'Reminders row drops must distinguish upper/lower row halves for same-bucket reorder');
    assert.ok(workspace.includes('targetAfterBucketRow'), 'Matrix row drops must support inserting after the hovered row');
    assert.ok(workspace.includes('targetAfterPriorityRow'), 'Top Priority row drops must support inserting after the hovered row');
    assert.ok(workspace.includes('resolveDropTarget={resolveDropTarget}'), 'Rows must resolve precise drop target from pointer position');
    assert.ok(workspace.includes('rankTopPriorityItems(props.feed.items'), 'Top Priority must rank across the full feed');
});

test('manager reminders frontend files and App line budget stay in bounds', () => {
    const app = read('public/manager/src/App.tsx');
    const required = [
        'public/manager/src/dashboard-reminders/reminders-api.ts',
        'public/manager/src/dashboard-reminders/useRemindersFeed.ts',
        'public/manager/src/dashboard-reminders/DashboardRemindersSidebar.tsx',
        'public/manager/src/dashboard-reminders/DashboardRemindersWorkspace.tsx',
        'public/manager/src/dashboard-reminders/InlineReminderTitle.tsx',
        'public/manager/src/dashboard-reminders/reminder-order.ts',
        'public/manager/src/dashboard-reminders/reminders-view-model.ts',
        'public/manager/src/dashboard-reminders/TrayRemindersApp.tsx',
        'public/manager/src/dashboard-reminders/ReminderDetailPopover.tsx',
        'public/manager/src/dashboard-reminders/useDashboardReminderDrag.ts',
        'public/manager/src/manager-dashboard-reminders.css',
        'public/manager/src/manager-dashboard-reminders-priority.css',
        'public/manager/src/manager-dashboard-reminders-parity.css',
        'public/manager/src/manager-tray-reminders.css',
    ];
    for (const path of required) {
        assert.equal(existsSync(join(projectRoot, path)), true, `${path} must exist`);
    }
    assert.ok(app.split('\n').length <= 500, 'App.tsx must stay under the 500-line dashboard budget');
});
