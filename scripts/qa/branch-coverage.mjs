// wp5a — which fixture state actually drives which ledger branch.
//
// The ledger says a branch exists and how it is reached in principle. The gate
// measures surface/state pairs. Nothing connected the two, so "28 branches"
// and "100 measured rows" were separate claims and the overlap was assumed.
// A reviewer was right to call that unproven (WP5A-BRANCH-PROOF-NOT-WIRED).
//
// This is the join: branch id -> the surface and state that renders it, plus
// the DOM that proves it is that branch rather than a lookalike. A branch with
// no entry is unproven and the gate says so by name.
import { buildTabStateLedger } from './tab-state-ledger.mjs';

/**
 * `state` is a key in FIXTURE_STATES, `surface` a key in FIXTURE_SURFACES.
 * `proof` runs inside the page and must return true only for this branch.
 */
export const BRANCH_COVERAGE = {
    // Terminal
    'TerminalPanel-nativeTerminal-rohung': {
        surface: 'tab-terminal', state: 'default',
        proof: () => document.querySelector('.d2-terminal-panel.is-state')?.textContent
            ?.includes('requires the cli-jaw Electron app') ?? false,
    },
    'TerminalPanel-nativeTerminal-d80rfi': {
        surface: 'tab-terminal', state: 'desktop-bridge',
        proof: () => Boolean(document.querySelector('.d2-terminal-panel.is-runtime')),
    },
    'TerminalPanel-snapshotsessionsleng-eohftu': {
        // NOT the create-error state: a failed create leaves a placeholder
        // session behind carrying the message, so the panel is not empty. The
        // branch-proof runner caught that mismatch.
        surface: 'tab-terminal', state: 'terminal-empty',
        proof: () => Boolean(document.querySelector('.d2-terminal-empty')),
    },
    'TerminalPanel-workingDirectoryErro-44uw78': {
        surface: 'tab-terminal', state: 'terminal-exited',
        proof: () => document.querySelector('.d2-terminal-status')?.textContent
            ?.includes('Terminal exited with code') ?? false,
    },
    'TerminalPanel-terminalTargetMatche-1x1xl0d': {
        surface: 'tab-terminal', state: 'terminal-cwd-loading',
        proof: () => Boolean(document.querySelector('.d2-terminal-panel.is-state[aria-busy="true"]')),
    },

    // Browser
    'BrowserPanel-bridgebrowsernativeA-v0vowd': {
        surface: 'tab-browser', state: 'default',
        proof: () => Boolean(document.querySelector('.d2-browser-panel')
            && !document.querySelector('.d2-browser-frame-wrap webview')),
    },
    'BrowserPanel-mountUrl-1jgd8r': {
        surface: 'tab-browser', state: 'desktop-bridge',
        proof: () => Boolean(document.querySelector('.d2-browser-frame-wrap webview')),
    },
    'BrowserPanel-state-1mgf5dk': {
        surface: 'tab-browser', state: 'browser-loading',
        proof: () => Boolean(document.querySelector('.d2-browser-loading')),
    },
    'BrowserPanel-statusError-o2zfhx': {
        surface: 'tab-browser', state: 'browser-crashed',
        proof: () => document.querySelector('.d2-browser-panel [role="alert"]')?.textContent
            ?.includes('Browser process crashed') ?? false,
    },
    'BrowserPanel-currentUrl-1297bqi': {
        surface: 'tab-browser', state: 'browser-shared',
        proof: () => document.querySelector('.d2-browser-agent-toggle')
            ?.getAttribute('data-shared') === 'true',
    },

    // Files
    'FileTreePanel-rowslength-1euy9ac': {
        surface: 'tab-files', state: 'files-empty',
        proof: () => document.querySelector('.d2-file-tree-message')?.textContent === 'No files found',
    },
    'FileTreePanel-rootStatestatus-152uttk': {
        surface: 'tab-files', state: 'files-error',
        proof: () => document.querySelector('.d2-file-tree-message')?.textContent
            ?.includes('Unable to load files (500)') ?? false,
    },
    'FileTreePanel-rootState-24stex': {
        surface: 'tab-files', state: 'default',
        proof: () => Boolean(document.querySelector('.d2-file-tree')),
    },
    'FileTreePanel-isUnavailable-1lt868y': {
        surface: 'tab-files', state: 'files-unavailable',
        proof: () => document.querySelector('.d2-file-tree-message')?.textContent
            ?.includes('File browser coming soon') ?? false,
    },
    'FileTreePanel-fileError-ub7e14': {
        surface: 'tab-files', state: 'files-open-error',
        proof: () => Boolean(document.querySelector('.d2-file-tree-message[role="alert"]')),
    },
    'FileTreePanel-port-k5swqt': {
        surface: 'tab-files', state: 'no-session',
        proof: () => document.querySelector('.d2-file-tree-message')?.textContent
            === 'Select an instance to browse files',
    },

    // Doc — everything it shows comes from the panel payload
    'DocPanel-payloadtruncated-kz7f4f': {
        surface: 'tab-doc', state: 'doc-truncated',
        proof: () => document.querySelector('.d2-doc-panel .d2-panel-state')?.textContent
            ?.includes('Truncated preview') ?? false,
    },
    'DocPanel-payloadbinary-1dkww0g': {
        surface: 'tab-doc', state: 'doc-binary',
        proof: () => (document.querySelector('.d2-doc-panel')?.textContent ?? '')
            .includes('Binary preview is not supported'),
    },
    'DocPanel-path-j822if': {
        surface: 'tab-doc', state: 'doc-ready',
        proof: () => Boolean(document.querySelector('.d2-doc-panel .d2-doc-prose')),
    },

    // Design
    'DesignPanel-payload-p78kgf': {
        surface: 'tab-design', state: 'design-url',
        proof: () => Boolean(document.querySelector('.d2-design-viewport iframe')),
    },
    'DesignPanel-payload-1ob32k3': {
        surface: 'tab-design', state: 'default',
        proof: () => (document.querySelector('.d2-design-panel .d2-panel-state')?.textContent ?? '')
            .includes('Open a design artifact'),
    },

    // Diff
    'DiffPanel-status-lahktt': {
        surface: 'tab-diff', state: 'diff-empty',
        proof: () => document.querySelector('.d2-diff-panel')?.textContent
            ?.includes('No unstaged changes') ?? false,
    },
    'DiffPanel-status-1fj1xoo': {
        surface: 'tab-diff', state: 'diff-error',
        proof: () => document.querySelector('.d2-diff-panel')?.textContent
            ?.includes('not a git repository') ?? false,
    },
    'DiffPanel-port-828rdo': {
        surface: 'tab-diff', state: 'desktop-bridge',
        proof: () => Boolean(document.querySelector('.d2-diff-panel')),
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
    return {
        total: rows.length,
        integration: integration.length,
        covered: covered.length,
        uncovered,
        stale,
        entries: covered.map(r => ({ id: r.id, ...BRANCH_COVERAGE[r.id], axis: r.axis, component: r.component })),
    };
}

if (process.argv[1]?.endsWith('branch-coverage.mjs')) {
    const status = branchCoverageStatus();
    console.log(JSON.stringify({
        ...status,
        entries: status.entries.map(e => `${e.id} <- ${e.surface}/${e.state}`),
    }, null, 2));
}
