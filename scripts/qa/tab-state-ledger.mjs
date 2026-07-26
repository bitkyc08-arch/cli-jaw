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
        lever: 'fake /api/code/git-info response',
        provider: 'FakeApiRouter (needs the same override as files)',
        reset: 'clear the override',
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
    return 'harness:panel-payload';   // Doc and Design read their panel payload
}

export function buildTabStateLedger() {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return manifest.branches
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
            };
        });
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
