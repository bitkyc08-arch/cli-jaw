// wp5a — the tool-tab state ledger, generated from the AST manifest.
//
// The first version of this table was pasted into a devlog document with the
// stable ids truncated, which made them ambiguous: two Terminal branches
// displayed identically and nothing could be matched one-to-one against a
// fixture result. Generating it removes that whole class of error, the same way
// the wp13 gate ledger did.
//
// Every row also carries HOW the branch is reached. "TBD" is a valid value
// while the plan is being written and an error once B starts, which the
// completion check below enforces.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MANIFEST = join(ROOT, 'tests/fixtures/wp12-state-manifest.json');

const TAB_COMPONENTS = [
    'TerminalPanel', 'BrowserPanel', 'FileTreePanel',
    'DocPanel', 'DesignPanel', 'DiffPanel',
];

// wp5b — the code tab's own components. Separate from TAB_COMPONENTS because
// they answer a different control surface: not a tool-tab payload but the
// /api/code harness, and because one of them renders SEVERAL screens from a
// single AST guard. The scenario ledger (scenario-ledger.mjs) owns the axis
// for these; this table is only their branch identity and how they are
// reached.
const CODE_COMPONENTS = [
    'CodeTabGate', 'CodeTab', 'CodeModelControl', 'CodeHistoryList',
];

// wp5c — the four feature tabs (plus the reminders panel's schedule sub-view
// and the hover-dock EmployeesSection). These are measured by the feature
// scenario ledger (scenario-feature-ledger.mjs); this table is only their
// branch identity and how they are reached.
const FEATURE_COMPONENTS = [
    'NotesPanel', 'NotesFileTree', 'NotesEmptyState', 'NotesCommandPalette',
    'NotesQuickSwitcher', 'BoardPanel', 'RemindersCore', 'ScheduleView',
    'ScheduleWorkEditor', 'EmployeesPanel', 'EmployeesSection',
];

// wp6 — the central settings workspace. Its components share the
// SettingsPageShell state machine plus the model picker. The legacy hover-dock
// settings components (SettingsTab, SettingsChannelsSection, SettingsMcpSection,
// SettingsModelsSection, SettingsPromptSection) are wp7a's hover-dock surface,
// NOT this one, so they stay out of the central sweep.
const SETTINGS_COMPONENTS = [
    'SettingsPageShell', 'SettingsSidebar', 'SettingsToast',
    'ModelPicker', 'ModelSettingsPanel',
];

/** The code branches are integration-reachable once the harness answers. */
const CODE_REACHABILITY = {
    // The one with no producer: fetchHistorySummaries only ever returns
    // ready/empty/error, so 'unavailable' is unreachable in the app.
    'CodeHistoryList-historystate-9e0ueb': 'shadowed',
};

/**
 * wp5c — feature branches that have no producer in the app.
 *
 * EmployeesSection is the hover-dock's own employees list, which is a
 * different surface from the side-pane EmployeesPanel and is wp7a's sweep,
 * not this one. It is declared shadowed here so the count cannot be improved
 * by silently leaving it out.
 */
const FEATURE_REACHABILITY = {
    'EmployeesSection-error-196y4ry': 'shadowed',
};

/** wp6 — settings branches with no producer in the central workspace. */
const SETTINGS_REACHABILITY = {
    // ModelSettingsPanel-port is the port-null prerequisite; reachable only
    // when no instance is selected, which the settings workspace always has.
    'ModelSettingsPanel-port-20qgxb': 'integration',
};

/**
 * Reachability is an audited decision keyed by the manifest's full stable id.
 * Keep this explicit: guards alone do not reveal whether SidePane pre-empts a
 * component branch or hardcodes a prop that makes it dead in the application.
 *
 * Evidence for the four shadowed branches:
 * - Terminal/Diff need a session, so SidePane.tsx:112-119 returns before either
 *   component can observe port === null (registry flags: SidePane.tsx:47,53).
 * - SidePane.tsx:157-165 is DocPanel's only consumer and fixes source to
 *   "native-file"; DocPanel.tsx:40,44-59 confines loading/error to "notes".
 *
 * No current manifest branch is component-only. Keep `component` as a valid
 * class so a future directly-renderable but app-unsupplied prop is explicit.
 */
const REACHABILITY = {
    'DesignPanel-payload-1ob32k3': 'integration',
    'DesignPanel-payload-p78kgf': 'integration',
    'DiffPanel-port-wf5dhy': 'shadowed',
    'DiffPanel-port-828rdo': 'integration',
    'DiffPanel-status-1fj1xoo': 'integration',
    'DiffPanel-status-lahktt': 'integration',
    'DocPanel-payloadtruncated-kz7f4f': 'integration',
    'DocPanel-path-j822if': 'integration',
    'DocPanel-payloadbinary-1dkww0g': 'integration',
    'DocPanel-effectiveStatus-jhvkk9': 'shadowed',
    'DocPanel-effectiveStatus-doprf1': 'shadowed',
    'BrowserPanel-currentUrl-1297bqi': 'integration',
    'BrowserPanel-state-1mgf5dk': 'integration',
    'BrowserPanel-mountUrl-1jgd8r': 'integration',
    'BrowserPanel-statusError-o2zfhx': 'integration',
    'BrowserPanel-bridgebrowsernativeA-v0vowd': 'integration',
    'FileTreePanel-port-k5swqt': 'integration',
    'FileTreePanel-isUnavailable-1lt868y': 'integration',
    'FileTreePanel-rootState-24stex': 'integration',
    'FileTreePanel-rootStatestatus-152uttk': 'integration',
    'FileTreePanel-rowslength-1euy9ac': 'integration',
    'FileTreePanel-fileError-ub7e14': 'integration',
    'TerminalPanel-nativeTerminal-rohung': 'integration',
    'TerminalPanel-port-drh6bl': 'shadowed',
    'TerminalPanel-workingDirectoryErro-44uw78': 'integration',
    'TerminalPanel-terminalTargetMatche-1x1xl0d': 'integration',
    'TerminalPanel-snapshotsessionsleng-eohftu': 'integration',
    'TerminalPanel-nativeTerminal-d80rfi': 'integration',
};

/**
 * How each branch is driven, keyed by the control surface it depends on.
 *
 * These are decisions, not implementation: which lever exists, what proves the
 * branch rendered, and how to put it back. The harness code that uses them is
 * B's work.
 */
const ACTIVATION = {
    'harness:capability': {
        lever: 'window.__jawE2E.setCapability({ reason })',
        provider: 'FakeApiRouter.capabilityResponse (e2e-app-harness)',
        reset: 'setCapability(null)',
    },
    'harness:files': {
        lever: 'window.__jawE2E.setFileTree({ ok, entries | error })',
        provider: 'FakeApiRouter.fileTreeResponse (e2e-app-harness)',
        reset: 'setFileTree(null)',
    },
    'harness:panel-payload': {
        lever: 'openPanel(type) with a payload on the panel instance',
        provider: 'AppScopeProvider.openPanel + SidePane payload plumbing',
        reset: 'close and reopen the panel',
    },
    'harness:scope': {
        lever: 'select or clear the active instance',
        provider: 'AppScopeProvider (selected / port)',
        reset: 'reselect the fixture instance',
    },
    'harness:desktop-bridge': {
        lever: 'DesktopBridgeProvider value (nativeTerminal, browser bridge)',
        provider: 'desktop-bridge-provider in the harness mount',
        reset: 'remount with the default bridge',
    },
    'harness:git': {
        // Planned as an HTTP override before the panel was read properly. The
        // diff panel does not call /api/code/git-info: it goes through the
        // desktop bridge's diff surface, so the lever is a bridge scenario
        // (diff-resolving / diff-empty / diff-error).
        lever: 'desktop bridge diff scenario (getRepoRoot / getDiffSummary)',
        provider: 'buildDesktopBridgeFixture diff surface',
        reset: 'remount with the default scenario',
    },
    'harness:code': {
        lever: 'window.__jawE2E.setCode(CodeFixtureConfig)',
        provider: 'FakeApiRouter.codeApi (e2e-app-harness)',
        reset: 'resetCode()',
    },
    'harness:notes': {
        lever: 'window.__jawE2E.setNotes(NotesFixtureConfig)',
        provider: 'FakeApiRouter.notesApi (e2e-app-harness)',
        reset: 'resetNotes()',
    },
    'harness:board': {
        lever: 'window.__jawE2E.setBoard(BoardFixtureConfig)',
        provider: 'FakeApiRouter.boardApi (e2e-app-harness)',
        reset: 'resetBoard()',
    },
    'harness:reminders': {
        lever: 'window.__jawE2E.setReminders(RemindersFixtureConfig) + setSchedule(ScheduleFixtureConfig)',
        provider: 'FakeApiRouter.reminder + scheduleApi (e2e-app-harness)',
        reset: 'resetReminders() + resetSchedule()',
    },
    'harness:employees': {
        lever: 'window.__jawE2E.setEmployees(EmployeesFixtureConfig)',
        provider: 'FakeApiRouter.employeesApi (e2e-app-harness)',
        reset: 'resetEmployees()',
    },
    'harness:settings': {
        lever: 'window.__jawE2E.setSettingsConfig(SettingsFixtureConfig)',
        provider: 'FakeApiRouter registry/settings/cli-registry handlers (e2e-app-harness)',
        reset: 'resetSettingsConfig()',
    },
};

/** Which lever each branch needs, decided by reading its guard. */
function routeFor(component, guard) {
    const g = guard.toLowerCase();
    if (component === 'TerminalPanel') {
        if (g.includes('nativeterminal')) return 'harness:desktop-bridge';
        if (g.includes('port === null')) return 'harness:scope';
        return 'harness:desktop-bridge';
    }
    if (component === 'BrowserPanel') return 'harness:desktop-bridge';
    if (component === 'FileTreePanel') {
        if (g.includes('port === null')) return 'harness:scope';
        return 'harness:files';
    }
    if (component === 'DiffPanel') {
        if (g.includes('port === null')) return 'harness:scope';
        return 'harness:git';
    }
    if (CODE_COMPONENTS.includes(component)) return 'harness:code';
    if (component.startsWith('Notes')) return 'harness:notes';
    if (component.startsWith('Board')) return 'harness:board';
    if (component.startsWith('Reminders') || component.startsWith('Schedule')) return 'harness:reminders';
    if (component.startsWith('Employees')) return 'harness:employees';
    if (SETTINGS_COMPONENTS.includes(component)) return 'harness:settings';
    return 'harness:panel-payload';   // Doc and Design read their panel payload
}

/** wp5b — the code tab's branches, reached through the code harness. */
function buildCodeLedger(manifest) {
    return manifest.branches
        .filter(b => CODE_COMPONENTS.includes(b.file.split('/').pop().replace('.tsx', '')))
        .map(b => {
            const component = b.file.split('/').pop().replace('.tsx', '');
            const route = routeFor(component, b.guard ?? '');
            const reachability = CODE_REACHABILITY[b.id] ?? 'integration';
            return {
                id: b.id,
                component,
                axis: b.axis,
                target: b.target,
                guard: b.guard,
                reachability,
                route,
                ...ACTIVATION[route],
                expectSelector: b.cls ? `.${b.cls.split(' ')[0]}` : '[data-state]',
                text: b.text ?? null,
            };
        });
}

/** wp5c — the feature tabs' branches, reached through their own harness. */
function buildFeatureLedger(manifest) {
    return manifest.branches
        .filter(b => FEATURE_COMPONENTS.includes(b.file.split('/').pop().replace('.tsx', '')))
        .map(b => {
            const component = b.file.split('/').pop().replace('.tsx', '');
            const route = routeFor(component, b.guard ?? '');
            const reachability = FEATURE_REACHABILITY[b.id] ?? 'integration';
            return {
                id: b.id,
                component,
                axis: b.axis,
                target: b.target,
                guard: b.guard,
                reachability,
                route,
                ...ACTIVATION[route],
                expectSelector: b.cls ? `.${b.cls.split(' ')[0]}` : '[data-state]',
                text: b.text ?? null,
            };
        });
}

/** wp6 — the central settings workspace's branches. */
function buildSettingsLedger(manifest) {
    return manifest.branches
        .filter(b => SETTINGS_COMPONENTS.includes(b.file.split('/').pop().replace('.tsx', '')))
        .map(b => {
            const component = b.file.split('/').pop().replace('.tsx', '');
            const route = routeFor(component, b.guard ?? '');
            const reachability = SETTINGS_REACHABILITY[b.id] ?? 'integration';
            return {
                id: b.id,
                component,
                axis: b.axis,
                target: b.target,
                guard: b.guard,
                reachability,
                route,
                ...ACTIVATION[route],
                expectSelector: b.cls ? `.${b.cls.split(' ')[0]}` : '[data-state]',
                text: b.text ?? null,
            };
        });
}

export function buildTabStateLedger() {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const toolTabs = manifest.branches
        .filter(b => TAB_COMPONENTS.includes(b.file.split('/').pop().replace('.tsx', '')))
        .map(b => {
            const component = b.file.split('/').pop().replace('.tsx', '');
            const route = routeFor(component, b.guard ?? '');
            const reachability = REACHABILITY[b.id];
            if (!reachability) throw new Error(`Missing reachability verdict for ${b.id}`);
            return {
                id: b.id,                       // the manifest id, not a truncation
                component,
                axis: b.axis,
                target: b.target,
                guard: b.guard,
                reachability,
                route,
                ...ACTIVATION[route],
                // What proves the branch rendered rather than a lookalike.
                expectSelector: b.cls ? `.${b.cls.split(' ')[0]}` : `[role="${b.axis === 'error' ? 'alert' : 'status'}"]`,
                // The copy this branch renders, straight from the manifest. A
                // selector alone does not identify a branch — several branches
                // of a panel share one — so the coverage check compares a
                // fixture's predicate against this.
                text: b.text ?? null,
            };
        });
    return [...toolTabs, ...buildCodeLedger(manifest), ...buildFeatureLedger(manifest), ...buildSettingsLedger(manifest)];
}

if (process.argv[1]?.endsWith('tab-state-ledger.mjs')) {
    const rows = buildTabStateLedger();
    const byComponent = rows.reduce((a, r) => ({ ...a, [r.component]: (a[r.component] ?? 0) + 1 }), {});
    const byRoute = rows.reduce((a, r) => ({ ...a, [r.route]: (a[r.route] ?? 0) + 1 }), {});
    const byReachability = rows.reduce(
        (a, r) => ({ ...a, [r.reachability]: a[r.reachability] + 1 }),
        { integration: 0, component: 0, shadowed: 0 },
    );
    const unrouted = rows.filter(r => !r.lever).map(r => r.id);
    const duplicates = rows.map(r => r.id).filter((id, i, all) => all.indexOf(id) !== i);
    console.log(JSON.stringify({
        total: rows.length, byComponent, byRoute, byReachability,
        integration: byReachability.integration ?? 0,
        unrouted, duplicateIds: [...new Set(duplicates)],
        rows,
    }, null, 2));
}
