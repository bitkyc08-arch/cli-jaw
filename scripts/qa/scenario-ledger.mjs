// wp5b — the code tab's USER-VISIBLE states, which are not its AST branches.
//
// The branch ledger (branch-coverage.mjs) is keyed on identities the state
// enumerator finds in the source. That map is 1:1 with the manifest and it is
// the wrong denominator for this tab, in both directions:
//
//   - One branch makes several screens. `!state.available` in CodeTabGate
//     renders three different reasons with three different meanings
//     (prerequisite / unsupported / error). Mapping one fixture to that
//     branch id proves one of them and silently skips two.
//   - Several screens have no branch at all. The model bar's four states, the
//     composer, the permission prompt and every request-only behaviour
//     (Stop sends a cancel and changes NOTHING on screen) are invisible to an
//     AST walk.
//
// So this file is a second, separate denominator with its own coverage, and
// `axis`/`target` authority lives HERE rather than in the manifest.
//
// Two independent judgements per row, because "can the app produce this?" and
// "did we prove it this run?" are different questions:
//
//   reachability   integration | component | shadowed
//   evidenceStatus planned | proven | not-applicable | environment-unavailable | blocked
//
// `not-applicable` is legal ONLY on a shadowed row: a state with no producer
// is not something to prove, but leaving it `planned` would park it as
// permanently unproven. The contract test enforces that pairing in both
// directions.

/** The capability answer that opens the gate. Everything past it needs this. */
const OPEN = { capability: { available: true, reason: 'ok' } };

/** Shapes pinned to `decodeCodeSessionValue` / `decodeStoredSessionValue`. */
const LIVE_SESSION = {
    sessionId: 'wp5b-live-1',
    cwd: '/tmp/wp4-e2e',
    status: 'idle',
    createdAt: 1_783_000_000_000,
    lastUsedAt: 1_783_000_000_000,
    modelId: 'sonnet-4.6',
    title: 'wp5b live session',
};
const STORED_SESSION = {
    sessionId: 'wp5b-stored-1',
    cwd: '/tmp/wp4-e2e',
    title: 'wp5b stored session',
    updatedAt: '2026-07-26T00:00:00.000Z',
    messageCount: 4,
};

/** Mirrors the harness default, so a row can vary one field of it. */
const CATALOG = {
    providers: [{ id: 'jwc', models: ['sonnet-4.6', 'opus-4.2'], efforts: ['low', 'medium', 'high'] }],
    defaultProvider: 'jwc',
    defaultModel: 'sonnet-4.6',
};

/**
 * Levers are declarative config for the harness (`__jawE2E.setCode`), so a
 * scenario says what the world looks like rather than how to script it.
 *
 * `actions` run in order before observation, and each one FAILS the scenario
 * if it cannot be performed — "the click missed but the screen happened to
 * match" must never read as a pass.
 *
 * `expectRequests` is checked against the requests recorded DURING the actions
 * only (the log is marked immediately before), so mount traffic never counts.
 * `count` is exact, including 0, which is how a button that quietly does
 * nothing gets caught.
 */
export const CODE_SCENARIOS = [
    // ── Capability gate ─────────────────────────────────────────────────────
    {
        id: 'gate-probing',
        branchId: 'CodeTabGate-state-1kxofnn',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the first probe has not answered yet; state is still null',
        code: { holdCapability: true },
        selector: '.d2-code-gate[data-state="probing"]',
        expected: 'Checking Code runtime…',
    },
    {
        id: 'gate-missing-binary',
        branchId: 'CodeTabGate-stateavailable-f8u8ym',
        reachability: 'integration',
        axis: 'prerequisite', target: 'StatePanel',
        why: 'jwc is not installed at all — a prerequisite, not a failure',
        code: { capability: { available: false, reason: 'missing_binary' } },
        selector: '.d2-code-gate[data-state="missing_binary"]',
        expected: 'jwc is not installed',
        // Round 1 WP5B-GATE-RETRY-COLLISION: the three unavailable screens and
        // the retry-in-flight screen share a data-state, so each must pin the
        // button's own condition.
        requires: '.d2-code-gate button:not([disabled])',
    },
    {
        id: 'gate-acp-unsupported',
        branchId: 'CodeTabGate-stateavailable-f8u8ym',
        reachability: 'integration',
        axis: 'unsupported', target: 'StatePanel',
        why: 'jwc exists but does not answer the ACP handshake',
        code: { capability: { available: false, reason: 'acp_unsupported' } },
        selector: '.d2-code-gate[data-state="acp_unsupported"]',
        expected: 'jwc version is not ACP-compatible',
        requires: '.d2-code-gate button:not([disabled])',
    },
    {
        id: 'gate-temporarily-unavailable',
        branchId: 'CodeTabGate-stateavailable-f8u8ym',
        reachability: 'integration',
        axis: 'error', target: 'StatePanel',
        why: 'the probe could not reach a working runtime; retryable',
        code: { capability: { available: false, reason: 'temporarily_unavailable' } },
        selector: '.d2-code-gate[data-state="temporarily_unavailable"]',
        expected: 'Code runtime is temporarily unavailable',
        requires: '.d2-code-gate button:not([disabled])',
    },
    {
        id: 'gate-retry',
        branchId: 'CodeTabGate-stateavailable-f8u8ym',
        reachability: 'integration',
        axis: 'loading', target: 'Control',
        why: 'retry re-probes with ?refresh=1 and disables the button while it runs',
        // The plan named `button[data-action="retry"]`, an attribute that does
        // not exist (WP5B-RETRY-ACTION-SELECTOR). The gate renders a bare
        // <button type="button">.
        code: { capability: { available: false, reason: 'temporarily_unavailable' }, holdCapabilityRefresh: true },
        actions: [{ kind: 'click', selector: '.d2-code-gate button' }],
        expectRequests: [
            { method: 'GET', path: '/i/3506/api/code/capabilities', query: 'refresh=1', count: 1 },
        ],
        selector: '.d2-code-gate button[disabled]',
        expected: 'Checking…',
    },
    {
        id: 'tab-suspense',
        branchId: 'CodeTabGate-state-1d583p4',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the lazy code chunk is still downloading after the gate opened',
        // The harness swaps window.fetch, which cannot see a dynamic import,
        // so this one is driven by Playwright's own route interception.
        code: { capability: { available: true, reason: 'ok' } },
        chunkDelay: true,
        selector: '.d2-code-gate[data-state="loading"]',
        expected: 'Loading Code…',
    },

    // ── History list ────────────────────────────────────────────────────────
    //
    // Live rows render regardless of `history.state` (CodeHistoryList.tsx:37),
    // so every row here either pins the history state or empties the live list
    // (round 1, WP5B-HISTORY-LIVE-OVERLAY).
    {
        id: 'history-loading',
        branchId: 'CodeHistoryList-historystate-1rc35h3',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the stored-session index has not answered yet',
        code: { ...OPEN, holdStored: true },
        selector: '.d2-code-session-picker[data-history-state="loading"] .d2-pane-empty',
        expected: 'Loading Code history…',
        absent: '.d2-code-session-row[data-live="1"]',
    },
    {
        id: 'history-empty',
        branchId: 'CodeHistoryList-historystate-1k3sbx',
        reachability: 'integration',
        axis: 'empty', target: 'StatePanel',
        why: 'no stored sessions AND no live ones',
        code: { ...OPEN, storedSessions: [], liveSessions: [] },
        selector: '.d2-code-session-picker[data-history-state="empty"] .d2-pane-empty',
        expected: 'No Code sessions yet',
        absent: '.d2-code-session-row',
    },
    {
        id: 'history-error',
        branchId: 'CodeHistoryList-historystate-1ee5oob',
        reachability: 'integration',
        // Manifest says unsupported/StatePanel; the DOM is a role="alert".
        // The scenario ledger owns the axis, so this is the correction.
        axis: 'error', target: 'Alert',
        why: 'the stored index could not be read',
        code: { ...OPEN, storedStatus: 500 },
        selector: '.d2-code-session-picker[data-history-state="error"] .d2-code-error[role="alert"]',
        expected: 'History unavailable:',
        absent: '.d2-code-session-row[data-live="1"]',
    },
    {
        id: 'history-unavailable',
        branchId: 'CodeHistoryList-historystate-9e0ueb',
        reachability: 'shadowed',
        evidenceStatus: 'not-applicable',
        axis: null, target: null,
        why: 'no producer: fetchHistorySummaries returns only ready/empty/error (code-history-adapter.ts:44-51)',
    },
    {
        id: 'history-live-ready',
        reachability: 'integration',
        axis: 'ready', target: 'List',
        why: 'a running session appears as a live row',
        code: { ...OPEN, liveSessions: [LIVE_SESSION], storedSessions: [] },
        // data-live alone is not enough: live rows survive loading and error.
        selector: '.d2-code-session-picker[data-history-state="empty"] .d2-code-session-row[data-live="1"]',
        expected: 'wp5b live session',
    },
    {
        id: 'history-stored-ready',
        reachability: 'integration',
        axis: 'ready', target: 'List',
        why: 'a persisted transcript appears as a stored row',
        code: { ...OPEN, liveSessions: [], storedSessions: [STORED_SESSION] },
        selector: '.d2-code-session-picker[data-history-state="ready"] .d2-code-session-row:not([data-live])',
        expected: 'wp5b stored session',
    },

    // ── Model bar ───────────────────────────────────────────────────────────
    //
    // data-state resolves loading > switching > error > ready
    // (CodeModelControl.tsx:166), so `ready` is also what an EMPTY catalogue
    // renders. Every ready row below therefore requires a visible option.
    {
        id: 'model-loading',
        reachability: 'integration',
        axis: 'loading', target: 'Control',
        why: 'the model catalogue request is still in flight',
        code: { ...OPEN, holdModels: true },
        selector: '.d2-code-model-control[data-state="loading"]',
        // The catalogue is fetched on mount, before any action can be marked,
        // so this row proves the loading FRAME rather than the request.
        requires: '.d2-model-picker-spinner',
    },
    {
        id: 'model-ready',
        reachability: 'integration',
        axis: 'ready', target: 'Control',
        why: 'a usable catalogue, not degraded',
        code: { ...OPEN },
        selector: '.d2-code-model-control[data-state="ready"]',
        // Without this the empty catalogue satisfies the same declaration.
        pattern: 'sonnet-4\\.6',
        absent: '.d2-code-model-note',
        // A local pick with no session must not reach the network.
        expectRequests: [{ method: 'POST', pathEndsWith: '/model', path: '*', count: 0 }],
    },
    {
        id: 'model-degraded',
        reachability: 'integration',
        axis: 'ready', target: 'Note',
        why: 'the catalogue came from the fallback inventory',
        code: { ...OPEN, models: { ...CATALOG, degraded: true } },
        selector: '.d2-code-model-control[data-state="ready"] .d2-code-model-note[role="status"]',
        expected: 'Using the available fallback model inventory.',
    },
    {
        id: 'model-empty-catalog',
        reachability: 'integration',
        axis: 'empty', target: 'Control',
        why: 'the server answered with no providers; the picker has nothing to offer',
        code: { ...OPEN, models: { providers: [], defaultProvider: 'jwc', defaultModel: 'sonnet-4.6' } },
        selector: '.d2-code-model-control[data-state="ready"] .d2-model-picker-trigger[disabled]',
        absent: '.d2-model-picker-option',
    },
    {
        id: 'model-error',
        branchId: 'CodeModelControl-error-59bdpt',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the catalogue request failed outright',
        code: { ...OPEN, modelsStatus: 400 },
        selector: '.d2-code-model-control[data-state="error"] .d2-code-model-error[role="alert"]',
        pattern: 'Code models',
    },
    {
        id: 'model-switching',
        reachability: 'integration',
        axis: 'loading', target: 'Control',
        why: 'a DIFFERENT model was chosen on an ACTIVE session and the switch is in flight',
        // Same model = early return, no session = local only: both send nothing.
        code: { ...OPEN, liveSessions: [LIVE_SESSION], holdModelSwitch: true },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'pick-model', value: 'opus-4.2' },
        ],
        // Model ids are provider-qualified (providerQualifiedModel at
        // CodeModelControl.tsx:22), so the wire value is not the bare name.
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/model', count: 1, bodyIncludes: { modelId: 'jwc/opus-4.2' } },
        ],
        selector: '.d2-code-model-control[data-state="switching"]',
    },
    {
        id: 'model-switch-committed',
        reachability: 'integration',
        axis: 'ready', target: 'Control',
        why: 'the switch resolved and the confirmed model actually changed',
        code: { ...OPEN, liveSessions: [LIVE_SESSION] },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'pick-model', value: 'opus-4.2' },
        ],
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/model', count: 1, bodyIncludes: { modelId: 'jwc/opus-4.2' } },
        ],
        selector: '.d2-code-model-control[data-state="ready"]',
        pattern: 'opus-4\\.2',
    },
    {
        id: 'model-switch-unknown-model',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the server confirmed a model the client does not know, so the switch is not trustworthy',
        code: { ...OPEN, liveSessions: [LIVE_SESSION], modelSwitchReturns: 'jwc/ghost-model' },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'pick-model', value: 'opus-4.2' },
        ],
        selector: '.d2-code-model-error[role="alert"][data-error-code="invalid_response"]',
        expectRequests: [{ method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/model', count: 1 }],
    },
    {
        id: 'model-switch-http-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the switch was rejected by transport, which is a different failure than an unknown model',
        code: { ...OPEN, liveSessions: [LIVE_SESSION], modelSwitchStatus: 400 },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'pick-model', value: 'opus-4.2' },
        ],
        selector: '.d2-code-model-error[role="alert"][data-error-code="http_error"]',
        expectRequests: [{ method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/model', count: 1 }],
    },

    // ── Session start errors ────────────────────────────────────────────────
    //
    // Three ways to fail to start, and two of them never reach the network.
    // Only the request count tells them apart (round 2,
    // WP5B-NEW-SESSION-LOCAL-ERRORS).
    {
        id: 'new-session-no-model',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'no model is selected, so the tab refuses before sending anything',
        code: { ...OPEN, models: { providers: [], defaultProvider: 'jwc', defaultModel: 'sonnet-4.6' } },
        actions: [{ kind: 'click', selector: '.d2-code-new-session' }],
        expectRequests: [{ method: 'POST', path: '/i/3506/api/code/sessions', count: 0 }],
        selector: '.d2-code-error[role="alert"]',
        expected: 'Select an available provider and model before starting a Code session',
    },
    {
        id: 'new-session-no-cwd',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the instance has no working directory, so there is nowhere to start',
        code: { ...OPEN },
        dropWorkingDir: true,
        actions: [{ kind: 'click', selector: '.d2-code-new-session' }],
        expectRequests: [{ method: 'POST', path: '/i/3506/api/code/sessions', count: 0 }],
        selector: '.d2-code-error[role="alert"]',
        expected: 'No working directory for this instance',
    },
    {
        id: 'list-error-no-session',
        branchId: 'CodeTab-listError-uj7lsx',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the create request itself failed, on the session-picker screen',
        code: { ...OPEN, createStatus: 500 },
        actions: [{ kind: 'click', selector: '.d2-code-new-session' }],
        expectRequests: [{ method: 'POST', path: '/i/3506/api/code/sessions', count: 1 }],
        selector: '.d2-code-error[role="alert"]',
        // Same words could appear next to a composer; the picker is the tell.
        requires: '.d2-code-session-picker',
        pattern: 'Code session create',
    },

    // ── Active session: composer, cancel, replay ────────────────────────────
    {
        id: 'composer-active',
        reachability: 'integration',
        axis: 'ready', target: 'Composer',
        why: 'a selected session shows the prompt composer',
        code: { ...OPEN, liveSessions: [LIVE_SESSION] },
        actions: [{ kind: 'click', selector: '.d2-code-session-row[data-live="1"]' }],
        selector: '.d2-code-composer textarea',
        // Selecting a session must not, by itself, send a prompt.
        expectRequests: [{ method: 'POST', pathEndsWith: '/prompt', path: '*', count: 0 }],
    },
    {
        id: 'active-empty-transcript',
        reachability: 'integration',
        axis: 'empty', target: 'Transcript',
        why: 'a live session with nothing replayed yet is a real, visible state',
        code: { ...OPEN, liveSessions: [LIVE_SESSION] },
        actions: [{ kind: 'click', selector: '.d2-code-session-row[data-live="1"]' }],
        selector: '.d2-code-tab .d2-code-stream',
        requires: '.d2-code-composer',
        // Scoped: the chat workbench renders its own turn slots, so a bare
        // `.d2-turn-slot` is always present and this row could never pass.
        absent: '.d2-code-stream .d2-turn-slot',
        expectRequests: [{ method: 'POST', pathEndsWith: '/prompt', path: '*', count: 0 }],
    },
    {
        id: 'composer-send-disabled',
        reachability: 'integration',
        axis: 'disabled', target: 'Control',
        why: 'an empty draft cannot be sent',
        code: { ...OPEN, liveSessions: [LIVE_SESSION] },
        actions: [{ kind: 'click', selector: '.d2-code-session-row[data-live="1"]' }],
        expectRequests: [{ method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/prompt', count: 0 }],
        selector: '.d2-code-composer-actions button[data-action="send"][disabled]',
        expected: 'Send',
        // Distinguishes this from composer-busy, where the draft survives.
        emptyDraft: true,
    },
    {
        id: 'composer-busy',
        reachability: 'integration',
        axis: 'loading', target: 'Control',
        why: 'a prompt is in flight; Send is disabled but the draft is still there',
        code: { ...OPEN, liveSessions: [LIVE_SESSION], holdPrompt: true },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'type', selector: '.d2-code-composer textarea', text: 'wp5b busy probe' },
            { kind: 'click', selector: '.d2-code-composer-actions button[data-action="send"]:not([disabled])' },
        ],
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/prompt', count: 1, bodyIncludes: { text: 'wp5b busy probe' } },
        ],
        selector: '.d2-code-composer-actions button[data-action="send"][disabled]',
        expected: 'Send',
        // Round 2 WP5B-COMPOSER-BUSY-COLLISION: the draft is what separates
        // this from prompt-success, which also renders a disabled Send.
        draftEquals: 'wp5b busy probe',
    },
    {
        id: 'prompt-success',
        reachability: 'integration',
        axis: 'ready', target: 'Composer',
        why: 'an accepted prompt clears the draft and releases the busy flag',
        code: { ...OPEN, liveSessions: [LIVE_SESSION] },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'type', selector: '.d2-code-composer textarea', text: 'wp5b accepted prompt' },
            { kind: 'click', selector: '.d2-code-composer-actions button[data-action="send"]:not([disabled])' },
        ],
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/prompt', count: 1, bodyIncludes: { text: 'wp5b accepted prompt' } },
        ],
        selector: '.d2-code-composer-actions button[data-action="send"][disabled]',
        expected: 'Send',
        draftEquals: '',
        absent: '.d2-code-error',
    },
    {
        id: 'list-error-active-session',
        branchId: 'CodeTab-listError-uj7lsx#2',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the prompt was rejected while a session was open',
        code: { ...OPEN, liveSessions: [LIVE_SESSION], promptStatus: 500 },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'type', selector: '.d2-code-composer textarea', text: 'wp5b rejected prompt' },
            { kind: 'click', selector: '.d2-code-composer-actions button[data-action="send"]:not([disabled])' },
        ],
        // Round 2 WP5B-LOAD-VS-PROMPT-ERROR: same DOM as intent-load-error,
        // so both directions are pinned.
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/prompt', count: 1 },
            { method: 'POST', path: '/i/3506/api/code/sessions/load', count: 0 },
        ],
        selector: '.d2-code-error[role="alert"]',
        requires: '.d2-code-composer',
        pattern: 'Code prompt',
    },
    {
        id: 'cancel-request',
        reachability: 'integration',
        axis: 'action', target: 'Control',
        why: 'Stop changes nothing on screen, so the request IS the only evidence',
        code: { ...OPEN, liveSessions: [LIVE_SESSION] },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'click', selector: '.d2-code-composer-actions button[data-action="cancel"]' },
        ],
        // Round 2 WP5B-CANCEL-SESSION-ID: the exact session id, so cancelling
        // the wrong session cannot pass.
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/sessions/wp5b-live-1/cancel', count: 1 },
        ],
        selector: '.d2-code-composer-actions button[data-action="cancel"]',
        expected: 'Stop',
    },

    // ── Stored-session replay (the sidebar's jwc intent) ─────────────────────
    {
        id: 'intent-load-pending',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'a stored conversation was picked and its replay has not arrived',
        code: { ...OPEN, storedSessions: [STORED_SESSION], holdLoad: true },
        actions: [{ kind: 'click', selector: '.d2-code-session-row:not([data-live])' }],
        expectRequests: [{ method: 'POST', path: '/i/3506/api/code/sessions/load', count: 1 }],
        selector: '.d2-code-loading[data-state="replaying"]',
        expected: 'Opening conversation…',
        // DEFECT-A: before the fix the composer appears immediately over an
        // empty transcript, so this row is red on the pre-fix code.
        absent: '.d2-code-composer',
    },
    {
        id: 'intent-load-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the replay failed; a third setListError producer with the same DOM as a prompt failure',
        code: { ...OPEN, storedSessions: [STORED_SESSION], loadStatus: 500 },
        actions: [{ kind: 'click', selector: '.d2-code-session-row:not([data-live])' }],
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/sessions/load', count: 1 },
            { method: 'POST', path: '/i/3506/api/code/sessions/wp5b-stored-1/prompt', count: 0 },
        ],
        selector: '.d2-code-error[role="alert"]',
        pattern: 'Code session load',
    },

    // ── Permissions (SSE-driven) ────────────────────────────────────────────
    {
        id: 'permission-pending',
        reachability: 'integration',
        axis: 'prerequisite', target: 'Group',
        why: 'the agent asked for permission and is waiting on the user',
        code: { ...OPEN, liveSessions: [LIVE_SESSION] },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'permission', requestId: 'wp5b-perm-1', sessionId: 'wp5b-live-1' },
        ],
        selector: '.d2-code-permission[role="group"]',
        pattern: 'Permission requested.*Allow once',
    },
    {
        id: 'permission-answered',
        reachability: 'integration',
        axis: 'ready', target: 'Group',
        why: 'answering sends the choice and dismisses the prompt',
        code: { ...OPEN, liveSessions: [LIVE_SESSION] },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'permission', requestId: 'wp5b-perm-1', sessionId: 'wp5b-live-1' },
            { kind: 'click', selector: '.d2-code-permission button' },
        ],
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/permissions/wp5b-perm-1', count: 1, bodyIncludes: { optionId: 'allow-once' } },
        ],
        selector: '.d2-code-composer',
        absent: '.d2-code-permission',
    },
    {
        id: 'permission-answer-error',
        reachability: 'integration',
        axis: 'error', target: 'Group',
        why: 'the answer failed in transit, so the choice must stay on screen (DEFECT-B)',
        code: { ...OPEN, liveSessions: [LIVE_SESSION], permissionAnswerStatus: 500 },
        actions: [
            { kind: 'click', selector: '.d2-code-session-row[data-live="1"]' },
            { kind: 'permission', requestId: 'wp5b-perm-1', sessionId: 'wp5b-live-1' },
            { kind: 'click', selector: '.d2-code-permission button' },
        ],
        expectRequests: [
            { method: 'POST', path: '/i/3506/api/code/permissions/wp5b-perm-1', count: 1 },
        ],
        // The prompt SURVIVES a failed answer, and the failure is reported.
        // Before the fix it vanished while the agent went on waiting.
        selector: '.d2-code-permission[role="group"]',
        requires: '.d2-code-error[role="alert"]',
        pattern: 'Permission requested',
    },
];

const EVIDENCE_STATUSES = new Set([
    'planned', 'proven', 'not-applicable', 'environment-unavailable', 'blocked',
]);
const REACHABILITIES = new Set(['integration', 'component', 'shadowed']);

/**
 * The denominators, audited rather than asserted.
 *
 * `integration` rows are the ones this phase must prove. A shadowed row is
 * excluded from the numerator AND declared, so the count cannot be improved by
 * quietly deleting a state nobody can reach.
 */
export function scenarioLedgerStatus() {
    // The runner consumes a generic {levers, panel, waitFor} shape; the code
    // rows were written before that shape existed and carry their lever as a
    // bare `code` field. Normalising here keeps the runner surface-agnostic
    // without rewriting every row.
    for (const scenario of CODE_SCENARIOS) {
        if (!scenario.levers) scenario.levers = scenario.code ? { code: scenario.code } : {};
        if (!scenario.panel) scenario.panel = 'code';
        if (!scenario.waitFor) scenario.waitFor = '.d2-code-tab, .d2-code-gate';
    }
    const ids = new Set();
    const duplicate = [];
    const malformed = [];

    for (const scenario of CODE_SCENARIOS) {
        if (ids.has(scenario.id)) duplicate.push(scenario.id);
        ids.add(scenario.id);

        const evidence = scenario.evidenceStatus ?? 'planned';
        if (!REACHABILITIES.has(scenario.reachability)) {
            malformed.push(`${scenario.id}: unknown reachability ${scenario.reachability}`);
        }
        if (!EVIDENCE_STATUSES.has(evidence)) {
            malformed.push(`${scenario.id}: unknown evidenceStatus ${evidence}`);
        }
        // The pairing rule, enforced both ways.
        if (evidence === 'not-applicable' && scenario.reachability !== 'shadowed') {
            malformed.push(`${scenario.id}: not-applicable is only legal on a shadowed row`);
        }
        if (scenario.reachability === 'shadowed' && evidence === 'proven') {
            malformed.push(`${scenario.id}: a shadowed row cannot be proven`);
        }
        // An integration row must say what it expects to see. Without this a
        // row could "pass" by asserting nothing at all.
        if (scenario.reachability === 'integration') {
            if (!scenario.selector) malformed.push(`${scenario.id}: integration row has no selector`);
            // A selector alone is a presence check, and presence is exactly
            // what neighbouring states share. Every row must additionally pin
            // copy, a draft value, a request count, or a discriminating
            // presence/absence claim.
            if (!scenario.expected && !scenario.pattern
                && scenario.draftEquals === undefined && !scenario.expectRequests
                && !scenario.requires && !scenario.absent) {
                malformed.push(`${scenario.id}: integration row asserts nothing beyond its own selector`);
            }
            if (!scenario.why) malformed.push(`${scenario.id}: integration row does not say why it exists`);
        }
        for (const action of scenario.actions ?? []) {
            if (!['click', 'type', 'select', 'check', 'press', 'pick-model', 'permission', 'wait'].includes(action.kind)) {
                malformed.push(`${scenario.id}: unknown action ${action.kind}`);
            }
        }
        for (const want of scenario.expectRequests ?? []) {
            if (typeof want.count !== 'number' || !want.method || !want.path) {
                malformed.push(`${scenario.id}: expectRequests entry needs method, path and an exact count`);
            }
        }
    }

    const integration = CODE_SCENARIOS.filter(s => s.reachability === 'integration');
    return {
        total: CODE_SCENARIOS.length,
        integration: integration.length,
        shadowed: CODE_SCENARIOS.filter(s => s.reachability === 'shadowed').length,
        withActions: CODE_SCENARIOS.filter(s => s.actions?.length).length,
        withRequestOracle: CODE_SCENARIOS.filter(s => s.expectRequests?.length).length,
        duplicate,
        malformed,
        scenarios: CODE_SCENARIOS,
        integrationScenarios: integration,
    };
}

export default CODE_SCENARIOS;
