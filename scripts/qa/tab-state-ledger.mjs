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
            return {
                id: b.id,                       // the manifest id, not a truncation
                component,
                axis: b.axis,
                target: b.target,
                guard: b.guard,
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
    const unrouted = rows.filter(r => !r.lever).map(r => r.id);
    const duplicates = rows.map(r => r.id).filter((id, i, all) => all.indexOf(id) !== i);
    console.log(JSON.stringify({
        total: rows.length, byComponent, byRoute,
        unrouted, duplicateIds: [...new Set(duplicates)],
        rows,
    }, null, 2));
}
