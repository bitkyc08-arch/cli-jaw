// wp13 — the gate ledger.
//
// The plan first said "110 gates" as a table of group targets. A reviewer
// rejected that, correctly: a target is not a contract. G1 read as 3 oracles ×
// 2 themes × 6 surfaces = 36 but was written as 12, and several groups
// multiplied by theme where theme provably changes nothing.
//
// So the count is generated, not asserted. Each gate is a unique tuple of
// (oracle, fixture, viewport, theme?) with a stable id, and the theme axis is
// applied ONLY to oracles whose result can differ per theme. Geometry cannot:
// the DOM and box model are identical, so doubling target-size checks by theme
// would be padding. Colour can, and did — the light-only accent failure is real.

/**
 * Surfaces, in the order the scanner opens them.
 *
 * notes, board and code were missing at first, and `side-pane` does not stand
 * in for them: it measures whichever panel happened to be restored. Each of the
 * three has its own typography, controls and empty states.
 */
export const SURFACES = [
    'sidebar', 'workbench', 'composer', 'side-pane', 'settings', 'hover-dock',
    'notes', 'board', 'code',
];

/** Widths that exercise different layout branches, not arbitrary numbers. */
export const VIEWPORTS = [
    { id: 'w1280', width: 1280, height: 800 },   // smallest supported desktop
    { id: 'w1440', width: 1440, height: 900 },   // design reference
    { id: 'w1728', width: 1728, height: 1080 },  // 16" MacBook
];

/**
 * themed: does this oracle's verdict depend on the theme?
 *
 * Colour-derived checks: yes. Geometry, naming and occlusion: no — same DOM,
 * same boxes. Claiming otherwise would double the count for free.
 */
const ORACLES = [
    { id: 'contrast-text', themed: true, scope: 'surface', what: 'every text node meets its WCAG AA ratio' },
    { id: 'contrast-icon', themed: true, scope: 'surface', what: 'icon-only controls meet 3:1 against their backdrop' },
    { id: 'target-size', themed: false, scope: 'surface', what: 'controls meet 24px or qualify for the spacing exception' },
    { id: 'accessible-name', themed: false, scope: 'surface', what: 'every control has a computed accessible name' },
    { id: 'occlusion', themed: false, scope: 'surface', what: 'no control is painted over by another element' },
    // The scan grew an `unreachable` metric before the ledger grew a gate for
    // it, so 21 clipped copy buttons were being found by a check nothing
    // enforced. A metric without a gate is a report, not a contract.
    { id: 'control-reachability', themed: false, scope: 'surface', what: 'no enabled control is cut off by an overflow:hidden ancestor' },
    { id: 'text-clipping', themed: false, scope: 'surface', what: 'text is not silently cut off without ellipsis' },
    { id: 'focus-visible', themed: true, scope: 'surface', what: 'keyboard focus draws a ring of at least 3:1' },
    { id: 'type-scale', themed: false, scope: 'surface', what: 'rendered font sizes land on the nine-step scale' },
    { id: 'radius-token', themed: false, scope: 'surface', what: 'border radii come from the token set' },
    { id: 'duration-token', themed: false, scope: 'surface', what: 'transition durations come from the token set' },
    { id: 'reduced-motion', themed: false, scope: 'surface', what: 'prefers-reduced-motion suppresses transitions' },
    { id: 'layout-overflow', themed: false, scope: 'viewport', what: 'no horizontal overflow at this width' },
    { id: 'layout-collision', themed: false, scope: 'viewport', what: 'no two siblings overlap unintentionally' },
    { id: 'console-clean', themed: false, scope: 'surface', what: 'reaching this surface logs no console error' },
];

/** Runtime and integration gates are scenario-shaped, not surface-shaped. */
const RUNTIME_GATES = [
    ['acp-spawn-failure', 'binary missing at spawn reports missing_binary, not a crash'],
    ['acp-handshake-timeout', 'a hung handshake resolves to temporarily_unavailable within the timeout'],
    ['acp-auth-rejection', 'an auth error surfaces its reason instead of being swallowed'],
    ['acp-malformed-line', 'a non-JSON line from the child is counted and reported, not dropped silently'],
    ['acp-rpc-timeout', 'an RPC that never answers rejects with rpc_timeout'],
    ['acp-late-response', 'a response arriving after its timeout does not resolve a stale promise'],
    ['acp-child-exit', 'child exit marks live sessions dead rather than leaving them pending'],
    ['acp-child-recovery', 'a session can be re-established after the child exits'],
    ['acp-multi-session-isolation', 'one session closing does not tear down another session'],
    ['acp-permission-expiry', 'a permission request left unanswered expires instead of pending forever'],
    ['acp-permission-cancel-race', 'cancelling while a permission is pending resolves both cleanly'],
    ['acp-diagnostics', 'the diagnostic snapshot reports child liveness, pending RPCs and last protocol error'],
    ['http-status-mapping', 'transport failures map to 503/504 rather than a blanket 500'],
    // 400, not 422: existing routes already answer 400 for malformed bodies and
    // changing it would break the client contract for no benefit.
    ['http-validation', 'malformed request bodies return 400 with a reason'],
    ['http-unknown-session', 'operations on an unknown session return 404'],
    ['acp-close-timeout-terminates', 'a close RPC timeout terminates the poisoned shared child rather than leaving it'],
    ['acp-survivors-reestablished', 'sessions that were live when the child died are re-established, not silently dropped'],
];

// Scoped to what the frontend can actually reach.
//
// The first draft counted session-fork and session-config, neither of which
// exists on CodeApiClient — phantom gates with a stable id and no activation
// path. Meanwhile closeSession, which the client does expose, was missing, as
// was the gate's own Suspense loading state. Every entry below maps to a method
// on the client or a branch of CodeTabGate.
const JAWCODE_GATES = [
    ['gate-probing', 'the capability gate renders a probing state while the probe is in flight'],
    ['gate-missing-binary', 'missing_binary renders its guidance and a retry affordance'],
    ['gate-acp-unsupported', 'acp_unsupported explains the version requirement'],
    ['gate-unavailable', 'temporarily_unavailable offers a retry'],
    ['gate-retry-succeeds', 'retry after a transient failure reaches the working tab'],
    ['gate-lazy-loading', 'the Suspense fallback renders while the Code chunk loads'],
    ['session-create', 'newSession adds a session and selects it'],
    ['session-list', 'listSessions reflects live sessions after a create'],
    ['session-load-stored', 'loadSession restores a stored conversation with its history'],
    ['session-model-change', 'setSessionModel persists and the picker reflects the new model'],
    ['session-model-rollback', 'a rejected model change restores the previous selection'],
    ['session-prompt-stream', 'prompt streams updates and terminates with a done event'],
    ['session-cancel', 'cancel stops a running prompt and settles the UI'],
    ['session-close', 'closeSession removes the session without disturbing its siblings'],
    ['permission-approve', 'answerPermission unblocks the waiting prompt'],
    ['permission-deny', 'a denied permission surfaces the refusal in the transcript'],
    ['recovery-in-progress-visible', 'the UI shows that a session is being re-established after a child exit'],
    ['recovery-failure-visible', 'a re-establishment that fails is surfaced instead of leaving a dead-looking session'],
];

export function buildLedger() {
    const gates = [];
    const push = (g) => gates.push(g);

    for (const oracle of ORACLES) {
        const themes = oracle.themed ? ['dark', 'light'] : ['any'];
        if (oracle.scope === 'surface') {
            for (const surface of SURFACES) {
                for (const theme of themes) {
                    push({
                        id: `visual/${oracle.id}/${surface}${theme === 'any' ? '' : `/${theme}`}`,
                        group: 'visual',
                        oracle: oracle.id,
                        fixture: surface,
                        viewport: 'w1440',
                        theme,
                        expected: oracle.what,
                    });
                }
            }
        } else {
            for (const vp of VIEWPORTS) {
                push({
                    id: `visual/${oracle.id}/${vp.id}`,
                    group: 'visual',
                    oracle: oracle.id,
                    fixture: 'shell',
                    viewport: vp.id,
                    theme: 'any',
                    expected: oracle.what,
                });
            }
        }
    }

    for (const [id, expected] of RUNTIME_GATES) {
        push({ id: `runtime/${id}`, group: 'runtime', oracle: id, fixture: 'acp-host', viewport: 'n/a', theme: 'any', expected });
    }
    for (const [id, expected] of JAWCODE_GATES) {
        push({ id: `jawcode/${id}`, group: 'jawcode', oracle: id, fixture: 'code-tab', viewport: 'w1440', theme: 'any', expected });
    }

    return gates;
}

if (process.argv[1]?.endsWith('gate-ledger.mjs')) {
    const gates = buildLedger();
    const byGroup = gates.reduce((acc, g) => ({ ...acc, [g.group]: (acc[g.group] ?? 0) + 1 }), {});
    const ids = new Set(gates.map((g) => g.id));
    console.log(JSON.stringify({
        total: gates.length,
        byGroup,
        duplicateIds: gates.length - ids.size,
        gates,
    }, null, 2));
}
