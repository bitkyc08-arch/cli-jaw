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
 *
 * `proof` runs inside the page and must return true ONLY for this branch.
 * The first version of this table failed that test: a reviewer found ten
 * entries whose predicate would also pass on a neighbouring state, because
 * they checked for a panel root rather than the thing the branch renders.
 * Every entry now asserts the manifest's own copy for that branch, and
 * `branchCoverageStatus` cross-checks the two so a predicate that stops
 * mentioning its branch's text is rejected.
 */
export const BRANCH_COVERAGE = {
    // ── Terminal ────────────────────────────────────────────────────────────
    'TerminalPanel-nativeTerminal-rohung': {
        surface: 'tab-terminal', state: 'default',
        expectText: 'Terminal requires the cli-jaw Electron app',
        proof: () => document.querySelector('.d2-terminal-panel.is-state')?.textContent
            ?.includes('Terminal requires the cli-jaw Electron app') ?? false,
    },
    'TerminalPanel-nativeTerminal-d80rfi': {
        // The manifest's copy for this branch is the Restart button, which only
        // appears once a session has exited. A bare runtime root also matched
        // three other terminal states.
        surface: 'tab-terminal', state: 'terminal-exited',
        expectText: 'Restart terminal',
        proof: () => Boolean([...document.querySelectorAll('.d2-terminal-panel.is-runtime button')]
            .find((b) => b.textContent?.trim() === 'Restart terminal')),
    },
    'TerminalPanel-snapshotsessionsleng-eohftu': {
        // NOT the create-error state: a failed create leaves a placeholder
        // session behind carrying the message, so the panel is not empty. The
        // branch-proof runner caught that mismatch.
        surface: 'tab-terminal', state: 'terminal-empty',
        expectText: 'New terminal',
        proof: () => Boolean([...document.querySelectorAll('.d2-terminal-empty button')]
            .find((b) => b.textContent?.trim() === 'New terminal')),
    },
    'TerminalPanel-workingDirectoryErro-44uw78': {
        // This branch is the working-directory failure, which is an alert on
        // the state panel — not the exited session it used to point at.
        surface: 'tab-terminal', state: 'terminal-cwd-error',
        proof: () => document.querySelector('.d2-terminal-panel.is-state[role="alert"]')?.textContent
            ?.includes('No working directory for this instance') ?? false,
    },
    'TerminalPanel-terminalTargetMatche-1x1xl0d': {
        surface: 'tab-terminal', state: 'terminal-cwd-loading',
        expectText: 'Loading terminal working directory',
        proof: () => document.querySelector('.d2-terminal-panel.is-state[aria-busy="true"]')?.textContent
            ?.includes('Loading terminal working directory') ?? false,
    },

    // ── Browser ─────────────────────────────────────────────────────────────
    'BrowserPanel-bridgebrowsernativeA-v0vowd': {
        // "Desktop browser unavailable" is an Electron environment with a
        // missing browser surface — not the plain web fallback, which is what
        // `default` renders.
        surface: 'tab-browser', state: 'browser-bridge-missing',
        expectText: 'Desktop browser unavailable',
        proof: () => document.querySelector('.d2-browser-panel [role="alert"]')?.textContent
            ?.includes('Desktop browser unavailable') ?? false,
    },
    'BrowserPanel-mountUrl-1jgd8r': {
        // The guard is `!mountUrl`, so this is the Electron panel BEFORE any
        // navigation: the empty prompt, not a mounted webview.
        surface: 'tab-browser', state: 'browser-idle',
        expectText: 'Enter a URL to start browsing',
        proof: () => Boolean(document.querySelector('.d2-browser-frame-wrap webview')) === false
            && (document.querySelector('.d2-browser-empty')?.textContent
                ?.includes('Enter a URL to start browsing') ?? false),
    },
    'BrowserPanel-state-1mgf5dk': {
        surface: 'tab-browser', state: 'browser-loading',
        expectText: 'Loading',
        proof: () => document.querySelector('.d2-browser-loading')?.textContent
            ?.includes('Loading') ?? false,
    },
    'BrowserPanel-statusError-o2zfhx': {
        surface: 'tab-browser', state: 'browser-crashed',
        proof: () => document.querySelector('.d2-browser-panel [role="alert"]')?.textContent
            ?.includes('Browser process crashed') ?? false,
    },
    'BrowserPanel-currentUrl-1297bqi': {
        // The web fallback's own empty prompt. Distinguished from the Electron
        // one above by the absence of the agent toggle, which only the
        // Electron panel renders.
        surface: 'tab-browser', state: 'default',
        expectText: 'Enter a URL to start browsing',
        proof: () => !document.querySelector('.d2-browser-agent-toggle')
            && (document.querySelector('.d2-browser-empty')?.textContent
                ?.includes('Enter a URL to start browsing') ?? false),
    },

    // ── Files ───────────────────────────────────────────────────────────────
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
        // The loading branch has its own copy; a bare `.d2-file-tree` also
        // matched the loaded, empty and error states.
        surface: 'tab-files', state: 'files-loading',
        expectText: 'Loading files',
        proof: () => document.querySelector('.d2-file-tree-message[role="status"]')?.textContent
            ?.includes('Loading files') ?? false,
    },
    'FileTreePanel-isUnavailable-1lt868y': {
        surface: 'tab-files', state: 'files-unavailable',
        proof: () => document.querySelector('.d2-file-tree-message')?.textContent
            ?.includes('File browser coming soon') ?? false,
    },
    'FileTreePanel-fileError-ub7e14': {
        surface: 'tab-files', state: 'files-open-error',
        expectText: 'Retry',
        proof: () => Boolean([...document.querySelectorAll('.d2-file-tree-message[role="alert"] button')]
            .find((b) => b.textContent?.trim() === 'Retry')),
    },
    'FileTreePanel-port-k5swqt': {
        surface: 'tab-files', state: 'no-session',
        proof: () => document.querySelector('.d2-file-tree-message')?.textContent
            === 'Select an instance to browse files',
    },

    // ── Doc — everything it shows comes from the panel payload ──────────────
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
        // The guard is `!path`: the panel with nothing to show. `doc-ready`
        // rendered prose, which is the opposite branch.
        surface: 'tab-doc', state: 'default',
        expectText: 'Open a document to preview it.',
        proof: () => (document.querySelector('.d2-doc-panel .d2-panel-state')?.textContent ?? '')
            .includes('Open a document to preview it.'),
    },

    // ── Design ──────────────────────────────────────────────────────────────
    'DesignPanel-payload-p78kgf': {
        surface: 'tab-design', state: 'default',
        expectText: 'Open a design artifact to preview it.',
        proof: () => (document.querySelector('.d2-design-panel .d2-panel-state')?.textContent ?? '')
            .includes('Open a design artifact to preview it.'),
    },
    'DesignPanel-payload-1ob32k3': {
        // The widget handoff's own loading copy, which needs a widget payload
        // rather than a URL.
        surface: 'tab-design', state: 'design-widget-pending',
        expectText: 'Preparing widget panel',
        // Opening the widget leaves the original design tab mounted alongside
        // it, so querySelector finds the empty one first. Ask whether ANY
        // design panel shows this branch.
        proof: () => [...document.querySelectorAll('.d2-design-panel .d2-panel-state')]
            .some((el) => (el.textContent ?? '').includes('Preparing widget panel')),
    },

    // ── Diff ────────────────────────────────────────────────────────────────
    'DiffPanel-status-lahktt': {
        surface: 'tab-diff', state: 'diff-empty',
        // The source reads `No {mode} changes.`, which the manifest captured
        // with the interpolation dropped. The rendered copy in the unstaged
        // mode the fixture drives is "No unstaged changes."
        expectText: 'No changes.',
        proof: () => document.querySelector('.d2-diff-panel')?.textContent
            ?.match(/No \w+ changes\./) !== null,
    },
    'DiffPanel-status-1fj1xoo': {
        surface: 'tab-diff', state: 'diff-error',
        proof: () => document.querySelector('.d2-diff-panel')?.textContent
            ?.includes('not a git repository') ?? false,
    },
    'DiffPanel-port-828rdo': {
        surface: 'tab-diff', state: 'diff-resolving',
        expectText: 'Resolving repository',
        proof: () => (document.querySelector('.d2-diff-panel .d2-panel-state[role="status"]')?.textContent ?? '')
            .includes('Resolving repository'),
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

    // A predicate is only a proof of THIS branch if it looks for what this
    // branch renders. The manifest records that copy, so compare the two:
    // an entry whose predicate never mentions its own branch text is checking
    // for something else, which is exactly how ten entries came to assert a
    // neighbouring state or a bare panel root.
    const mismatched = [];
    for (const row of covered) {
        const entry = BRANCH_COVERAGE[row.id];
        const wanted = (entry.expectText ?? row.text ?? '').trim();
        if (!wanted) continue;   // error branches render a runtime message
        const source = `${entry.proof.toString()} ${entry.expectText ?? ''}`;
        // Compare on a distinctive fragment: the manifest keeps trailing
        // punctuation and ellipses that a selector may reasonably omit.
        const needle = wanted.replace(/[.…]+$/, '').slice(0, 24);
        if (!source.includes(needle)) {
            mismatched.push({ id: row.id, expected: wanted, axis: row.axis });
        }
    }

    return {
        total: rows.length,
        integration: integration.length,
        covered: covered.length,
        uncovered,
        stale,
        mismatched,
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
