// wp5a — which fixture state actually drives which ledger branch.
//
// The ledger says a branch exists and how it is reached in principle. The gate
// measures surface/state pairs. Nothing connected the two, so "28 branches"
// and "100 measured rows" were separate claims and the overlap was assumed.
//
// This is the join: branch id -> the surface and state that renders it, plus
// the DOM that proves it is that branch rather than a lookalike.
//
// The proofs are DATA, not functions. They used to be predicates, and the
// check that they actually asserted their own branch read their source text —
// which a reviewer defeated twice, first with `expectText` alone and then with
// `void 'Expected copy'; return true`. Reading a function's source can never
// establish what it evaluates. An entry now declares WHERE to look, the runner
// performs the observation, and the words it compares come from the manifest
// rather than from this file.
import { buildTabStateLedger } from './tab-state-ledger.mjs';

/**
 * Each entry is:
 *   surface   a key in FIXTURE_SURFACES
 *   state     a key in FIXTURE_STATES
 *   selector  where this branch renders
 *   absent    optional selector that must NOT be present, to separate this
 *             branch from a neighbour that renders the same words
 *   text      optional override for branches whose manifest copy is
 *             interpolated or empty; otherwise the manifest's own text is
 *             used and cannot drift from the ledger
 *   pattern   optional regex source, for copy the component interpolates
 */
export const BRANCH_COVERAGE = {
    // ── Terminal ────────────────────────────────────────────────────────────
    'TerminalPanel-nativeTerminal-rohung': {
        surface: 'tab-terminal', state: 'default',
        selector: '.d2-terminal-panel.is-state',
    },
    'TerminalPanel-nativeTerminal-d80rfi': {
        // The manifest's copy is the Restart button, which appears only once a
        // session has exited. A bare runtime root matched three other states —
        // and the Restart button alone is not enough either: a failed create
        // also offers it, which the negative matrix caught. The status line's
        // own words are what separate the two.
        surface: 'tab-terminal', state: 'terminal-exited',
        selector: '.d2-terminal-panel.is-runtime .d2-terminal-status[role="status"]',
        requires: '.d2-terminal-restart',
        pattern: 'Terminal exited with code \\d+.*Restart terminal',
    },
    'TerminalPanel-snapshotsessionsleng-eohftu': {
        // NOT create-error: a failed create leaves a placeholder session behind
        // carrying the message, so the panel is not empty.
        surface: 'tab-terminal', state: 'terminal-empty',
        selector: '.d2-terminal-empty button',
    },
    'TerminalPanel-workingDirectoryErro-44uw78': {
        surface: 'tab-terminal', state: 'terminal-cwd-error',
        selector: '.d2-terminal-panel.is-state[role="alert"]',
        // The manifest has no static copy for this branch: the message is
        // whatever the failed lookup reported.
        text: 'No working directory for this instance',
    },
    'TerminalPanel-terminalTargetMatche-1x1xl0d': {
        surface: 'tab-terminal', state: 'terminal-cwd-loading',
        selector: '.d2-terminal-panel.is-state[aria-busy="true"]',
    },

    // ── Browser ─────────────────────────────────────────────────────────────
    'BrowserPanel-bridgebrowsernativeA-v0vowd': {
        // Electron with the browser surface absent — not the web fallback.
        surface: 'tab-browser', state: 'browser-bridge-missing',
        selector: '.d2-browser-panel [role="alert"]',
    },
    'BrowserPanel-mountUrl-1jgd8r': {
        // The guard is `!mountUrl`: the Electron panel BEFORE any navigation.
        // The agent toggle is what makes it the Electron one; the absent
        // webview is what makes it the pre-navigation branch.
        surface: 'tab-browser', state: 'browser-idle',
        selector: '.d2-browser-empty',
        absent: '.d2-browser-frame-wrap webview',
        requires: '.d2-browser-agent-toggle',
    },
    'BrowserPanel-state-1mgf5dk': {
        surface: 'tab-browser', state: 'browser-loading',
        selector: '.d2-browser-loading',
    },
    'BrowserPanel-statusError-o2zfhx': {
        surface: 'tab-browser', state: 'browser-crashed',
        selector: '.d2-browser-panel [role="alert"]',
        text: 'Browser process crashed. Reload to retry.',
    },
    'BrowserPanel-currentUrl-1297bqi': {
        // The web fallback's own empty prompt, told apart from the Electron
        // one by the absence of the agent toggle.
        surface: 'tab-browser', state: 'default',
        selector: '.d2-browser-empty',
        absent: '.d2-browser-agent-toggle',
    },

    // ── Files ───────────────────────────────────────────────────────────────
    'FileTreePanel-port-k5swqt': {
        surface: 'tab-files', state: 'no-session',
        selector: '.d2-file-tree-message',
    },
    'FileTreePanel-isUnavailable-1lt868y': {
        surface: 'tab-files', state: 'files-unavailable',
        selector: '.d2-file-tree-message',
    },
    'FileTreePanel-rootState-24stex': {
        surface: 'tab-files', state: 'files-loading',
        selector: '.d2-file-tree-message[role="status"]',
    },
    'FileTreePanel-rootStatestatus-152uttk': {
        surface: 'tab-files', state: 'files-error',
        selector: '.d2-file-tree-message',
        text: 'Unable to load files (500)',
    },
    'FileTreePanel-rowslength-1euy9ac': {
        surface: 'tab-files', state: 'files-empty',
        selector: '.d2-file-tree-message',
        match: 'exact',
    },
    'FileTreePanel-fileError-ub7e14': {
        surface: 'tab-files', state: 'files-open-error',
        selector: '.d2-file-tree-message[role="alert"] button',
    },

    // ── Doc — everything it shows comes from the panel payload ──────────────
    'DocPanel-payloadtruncated-kz7f4f': {
        surface: 'tab-doc', state: 'doc-truncated',
        selector: '.d2-doc-panel:not([hidden]) .d2-panel-state',
    },
    'DocPanel-payloadbinary-1dkww0g': {
        surface: 'tab-doc', state: 'doc-binary',
        selector: '.d2-doc-panel:not([hidden]) .d2-panel-state[role="status"]',
    },
    'DocPanel-path-j822if': {
        // The guard is `!path`: the panel with nothing to show.
        surface: 'tab-doc', state: 'default',
        selector: '.d2-doc-panel:not([hidden]) .d2-panel-state',
    },

    // ── Design ──────────────────────────────────────────────────────────────
    'DesignPanel-payload-p78kgf': {
        surface: 'tab-design', state: 'default',
        selector: '.d2-design-panel:not([hidden]) .d2-panel-state',
    },
    'DesignPanel-payload-1ob32k3': {
        // The widget handoff's loading copy, which needs a widget payload.
        surface: 'tab-design', state: 'design-widget-pending',
        selector: '.d2-design-panel:not([hidden]) .d2-panel-state',
    },

    // ── Diff ────────────────────────────────────────────────────────────────
    'DiffPanel-port-828rdo': {
        surface: 'tab-diff', state: 'diff-resolving',
        selector: '.d2-diff-panel:not([hidden]) .d2-panel-state[role="status"]',
    },
    'DiffPanel-status-1fj1xoo': {
        surface: 'tab-diff', state: 'diff-error',
        selector: '.d2-diff-panel:not([hidden]) .d2-panel-state.is-error[role="alert"]',
        text: 'not a git repository',
    },
    'DiffPanel-status-lahktt': {
        // The component renders `No {mode} changes.`; the manifest captured it
        // with the interpolation dropped, so this branch declares the pattern.
        surface: 'tab-diff', state: 'diff-empty',
        selector: '.d2-diff-panel:not([hidden]) .d2-panel-state',
        pattern: '^No \\w+ changes\\.$',
    },
};

/**
 * Branches that are proven, and branches that are not.
 *
 * `shadowed` rows are excluded from the denominator on purpose: the audit in
 * tab-state-ledger.mjs shows the application pre-empts them, so demanding a
 * fixture for them would mean faking a state users cannot reach.
 */
export function branchCoverageStatus() {
    const rows = buildTabStateLedger();
    const integration = rows.filter(r => r.reachability === 'integration');
    const covered = integration.filter(r => BRANCH_COVERAGE[r.id]);
    const uncovered = integration.filter(r => !BRANCH_COVERAGE[r.id]).map(r => r.id);
    const stale = Object.keys(BRANCH_COVERAGE).filter(id => !rows.some(r => r.id === id));

    // An entry must say what it expects to see, one way or another. A branch
    // whose manifest copy is a runtime message has to state its own `text` or
    // `pattern`; anything else takes the manifest's words, which is what keeps
    // the two in step.
    const underspecified = covered
        .filter(r => {
            const e = BRANCH_COVERAGE[r.id];
            return !e.selector || !(e.text || e.pattern || (r.text ?? '').trim());
        })
        .map(r => r.id);

    return {
        total: rows.length,
        integration: integration.length,
        covered: covered.length,
        uncovered,
        stale,
        underspecified,
        entries: covered.map(r => ({
            id: r.id,
            ...BRANCH_COVERAGE[r.id],
            // The expected copy is resolved HERE, from the ledger, so an entry
            // cannot quietly assert something the manifest does not say.
            expected: BRANCH_COVERAGE[r.id].text ?? (r.text ?? '').trim(),
            axis: r.axis,
            component: r.component,
        })),
    };
}

if (process.argv[1]?.endsWith('branch-coverage.mjs')) {
    const status = branchCoverageStatus();
    console.log(JSON.stringify({
        ...status,
        entries: status.entries.map(e => `${e.id} <- ${e.surface}/${e.state} @ ${e.selector}`),
    }, null, 2));
}
