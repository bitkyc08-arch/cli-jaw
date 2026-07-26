// wp5c — the feature tabs' USER-VISIBLE states, derived from an
// (action × lifecycle) matrix rather than recalled (see devlog 074, A-gate
// round 5). Every async action yields in-flight / success / error (+busy); an
// empty list is a success special case; producers that share a DOM are told
// apart by the request.
//
// Rows are surface-agnostic: each declares `levers` (harness config), `panel`
// (which side-pane tab), `waitFor` (the surface's ready selector), then the
// same action/request/DOM claims the code ledger uses. The runner merges this
// with the code ledger and drives both.

/** The side-pane panel each tab opens, and its ready selector. */
const PANEL = {
    notes: { panel: 'notes', waitFor: '.d2-notes-workspace, .d2-notes-empty-state' },
    board: { panel: 'board', waitFor: '.d2-board-canvas, .d2-board-state, .d2-board-error' },
    reminders: { panel: 'reminders', waitFor: '.d2-reminders-loading, .d2-reminders-error, .d2-reminders-list, .d2-reminders-empty, .d2-reminders-form' },
    employees: { panel: 'employees', waitFor: '.d2-employees-panel' },
};

// The side pane is narrow, which puts the board in compact mode at the
// default 1440x900 viewport: it renders one lane as a <select> instead of
// every lane (BoardPanel.tsx:96,364). A wider viewport keeps the pane wide
// enough to show all lanes, which is what the lane-level rows assert on.
const BOARD_WIDE = { width: 1920, height: 1000 };

export const FEATURE_SCENARIOS = [
    // ── employees ───────────────────────────────────────────────────────────
    // Three sub-requests, fan-out via Promise.allSettled. employees is
    // required; workers/progress degrade to a warning each.
    {
        id: 'employees-loading',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the employees registry has not answered yet',
        ...PANEL.employees,
        levers: { employees: { holdEmployees: true } },
        selector: '.d2-employees-state[role="status"]',
        expected: 'Loading employees',
    },
    {
        id: 'employees-error',
        branchId: 'EmployeesPanel-status-12by3ra',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the employees registry read failed; this is the only sub-request that throws',
        ...PANEL.employees,
        levers: { employees: { employeesStatus: 500 } },
        selector: '.d2-employees-state.is-error[role="alert"]',
        // The read fires on mount, before any action, so the request is not
        // markable; the role=alert is the distinguishing evidence.
        requires: '.d2-employees-panel',
    },
    {
        id: 'employees-empty',
        branchId: 'EmployeesPanel-status-prch9g',
        reachability: 'integration',
        axis: 'empty', target: 'StatePanel',
        why: 'registry answered with no rows and both sub-requests succeeded',
        ...PANEL.employees,
        levers: { employees: { employees: [] } },
        selector: '.d2-employees-state',
        expected: 'No employees configured.',
        absent: '.d2-employees-warning',
    },
    {
        id: 'employees-ready',
        reachability: 'integration',
        axis: 'ready', target: 'List',
        why: 'rows render with active and idle states',
        ...PANEL.employees,
        levers: {
            employees: {
                employees: [
                    { id: 'emp-1', name: 'Ada', cli: 'codex', model: 'gpt-5.5', role: 'reviewer', status: 'running' },
                    { id: 'emp-2', name: 'Grace', cli: 'jwc', model: null, role: null, status: 'idle' },
                ],
            },
        },
        selector: '.d2-employee-row',
        expected: 'Ada',
    },
    {
        id: 'employees-warning-workers',
        reachability: 'integration',
        axis: 'degraded', target: 'Note',
        why: 'the active-workers read failed but employees succeeded, so the panel warns instead of failing',
        ...PANEL.employees,
        levers: { employees: { employees: [{ id: 'emp-1', name: 'Ada', cli: 'codex', model: null, role: null, status: 'idle' }], workersStatus: 500 } },
        selector: '.d2-employees-warning[role="status"]',
        expected: 'Active worker status is unavailable.',
    },
    {
        id: 'employees-warning-progress',
        reachability: 'integration',
        axis: 'degraded', target: 'Note',
        why: 'the progress read failed but employees succeeded',
        ...PANEL.employees,
        levers: { employees: { employees: [{ id: 'emp-1', name: 'Ada', cli: 'codex', model: null, role: null, status: 'idle' }], progressStatus: 500 } },
        selector: '.d2-employees-warning[role="status"]',
        expected: 'Worker progress is unavailable.',
    },
    {
        id: 'employees-warning-both',
        branchId: 'EmployeesPanel-state-1kgnjht',
        reachability: 'integration',
        axis: 'degraded', target: 'Note',
        why: 'both orchestrate reads failed; two warnings render',
        ...PANEL.employees,
        levers: { employees: { employees: [{ id: 'emp-1', name: 'Ada', cli: 'codex', model: null, role: null, status: 'idle' }], workersStatus: 500, progressStatus: 500 } },
        selector: '.d2-employees-warning[role="status"]',
        expected: 'Active worker status is unavailable.',
    },
    {
        id: 'employees-attention',
        reachability: 'integration',
        axis: 'prerequisite', target: 'Badge',
        why: 'a row carrying an attention field shows its badge',
        ...PANEL.employees,
        levers: {
            employees: {
                employees: [{ id: 'emp-1', name: 'Ada', cli: 'codex', model: null, role: null, status: 'running' }],
                progress: [{ agentId: 'emp-1', current: { state: 'running', taskPreview: 'Reviewing', progressUpdatedAt: 1_783_000_000_000, attention: { kind: 'blocked', message: 'waiting on review' } } }],
            },
        },
        selector: '.d2-employee-row .is-attention',
        expected: 'blocked',
    },

    // ── board ───────────────────────────────────────────────────────────────
    // BoardPanel tracks loading, a shared error, creating and per-task busyIds.
    {
        id: 'board-loading',
        branchId: 'BoardPanel-loading-65ewcf',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the task list is in flight and there is nothing cached',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { holdList: true } },
        selector: '.d2-board-state[role="status"]',
        expected: 'Loading board',
    },
    {
        id: 'board-load-error',
        branchId: 'BoardPanel-error-100jhrs',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the list read failed',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { listStatus: 500 } },
        selector: '.d2-board-error[role="alert"]',
        requires: '.d2-board-error button',
    },
    {
        id: 'board-all-empty',
        branchId: 'BoardPanel-laneTaskslength-d5vk33',
        reachability: 'integration',
        axis: 'empty', target: 'List',
        why: 'every lane renders its own "No tasks" placeholder',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [] } },
        selector: '.d2-board-lane-empty',
        expected: 'No tasks',
    },
    {
        id: 'board-some-empty',
        reachability: 'integration',
        axis: 'empty', target: 'List',
        why: 'a lane with tasks sits beside lanes that are empty',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [{ id: 'task-1', title: 'wp5c board task', lane: 'ready' }] } },
        // The pane is always compact, so the task sits in the Todo lane and
        // must be selected before it is visible. In compact mode the OTHER
        // lanes are not rendered, so the empty-lane placeholder cannot
        // co-exist with a visible card — that combination is a wide-mode-only
        // state and is delegated to the visual gate instead of asserted here.
        actions: [{ kind: 'select', selector: '.d2-board-lane-picker select', value: 'todo' }],
        selector: '.d2-board-card',
        expected: 'wp5c board task',
    },
    {
        id: 'board-composer-open',
        reachability: 'integration',
        axis: 'ready', target: 'Form',
        why: 'opening the create form shows Title/Lane before any POST',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [] } },
        actions: [{ kind: 'click', selector: '.d2-board-create-button' }],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/board/tasks', count: 0 }],
        selector: '#d2-board-composer',
        requires: '.d2-board-title-field input',
    },
    {
        id: 'board-create-busy',
        reachability: 'integration',
        axis: 'loading', target: 'Form',
        why: 'creating disables the submit while the POST is in flight',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [], holdCreate: true } },
        actions: [
            { kind: 'click', selector: '.d2-board-create-button' },
            { kind: 'type', selector: '.d2-board-title-field input', text: 'wp5c new board task' },
            { kind: 'click', selector: '.d2-board-submit:not([disabled])' },
        ],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/board/tasks', count: 1, bodyIncludes: { title: 'wp5c new board task', lane: 'backlog' } }],
        selector: '.d2-board-submit[disabled]',
        expected: 'Creating',
    },
    {
        id: 'board-create-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the create POST was rejected',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [], createStatus: 500 } },
        actions: [
            { kind: 'click', selector: '.d2-board-create-button' },
            { kind: 'type', selector: '.d2-board-title-field input', text: 'wp5c failing task' },
            { kind: 'click', selector: '.d2-board-submit:not([disabled])' },
        ],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/board/tasks', count: 1 }],
        selector: '.d2-board-error[role="alert"]',
    },
    {
        id: 'board-edit-busy',
        reachability: 'integration',
        axis: 'loading', target: 'Form',
        why: 'the edit dialog disables its fields while the save is in flight',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [{ id: 'task-1', title: 'wp5c busy task', lane: 'ready' }], holdUpdate: true } },
        actions: [
            { kind: 'select', selector: '.d2-board-lane-picker select', value: 'todo' },
            { kind: 'click', selector: '.d2-board-card-body[data-board-task-id="task-1"]' },
            { kind: 'type', selector: '.d2-board-dialog-field input', text: 'wp5c busy task edited' },
            { kind: 'click', selector: '.d2-board-dialog-save:not([disabled])' },
        ],
        expectRequests: [{ method: 'PATCH', path: '/api/dashboard/board/tasks/task-1', count: 1 }],
        selector: '.d2-board-dialog-save[disabled]',
        expected: 'Saving',
    },
    {
        id: 'board-edit-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the edit PATCH was rejected; one of the shared-error producers',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [{ id: 'task-1', title: 'wp5c edit task', lane: 'ready' }], updateStatus: 500 } },
        actions: [
            { kind: 'select', selector: '.d2-board-lane-picker select', value: 'todo' },
            { kind: 'click', selector: '.d2-board-card-body[data-board-task-id="task-1"]' },
            { kind: 'type', selector: '.d2-board-dialog-field input', text: 'wp5c edit task changed' },
            { kind: 'click', selector: '.d2-board-dialog-save:not([disabled])' },
        ],
        expectRequests: [{ method: 'PATCH', path: '/api/dashboard/board/tasks/task-1', count: 1 }],
        selector: '.d2-board-error[role="alert"]',
    },
    {
        id: 'board-delete-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the delete was rejected; the other shared-error producer',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [{ id: 'task-1', title: 'wp5c delete task', lane: 'ready' }], deleteStatus: 500 } },
        actions: [
            { kind: 'select', selector: '.d2-board-lane-picker select', value: 'todo' },
            { kind: 'click', selector: '.d2-board-card-body[data-board-task-id="task-1"]' },
            { kind: 'click', selector: '.d2-board-dialog-delete' },
        ],
        expectRequests: [{ method: 'DELETE', path: '/api/dashboard/board/tasks/task-1', count: 1 }],
        selector: '.d2-board-error[role="alert"]',
    },
];

const EVIDENCE_STATUSES = new Set([
    'planned', 'proven', 'not-applicable', 'environment-unavailable', 'blocked',
]);
const REACHABILITIES = new Set(['integration', 'component', 'shadowed']);

/** Same contract as the code ledger: clean, audited, non-overlapping denominators. */
export function featureScenarioStatus() {
    const ids = new Set();
    const duplicate = [];
    const malformed = [];
    for (const scenario of FEATURE_SCENARIOS) {
        if (ids.has(scenario.id)) duplicate.push(scenario.id);
        ids.add(scenario.id);
        const evidence = scenario.evidenceStatus ?? 'planned';
        if (!REACHABILITIES.has(scenario.reachability)) malformed.push(`${scenario.id}: unknown reachability ${scenario.reachability}`);
        if (!EVIDENCE_STATUSES.has(evidence)) malformed.push(`${scenario.id}: unknown evidenceStatus ${evidence}`);
        if (evidence === 'not-applicable' && scenario.reachability !== 'shadowed') malformed.push(`${scenario.id}: not-applicable is only legal on a shadowed row`);
        if (scenario.reachability === 'shadowed' && evidence === 'proven') malformed.push(`${scenario.id}: a shadowed row cannot be proven`);
        if (scenario.reachability === 'integration') {
            if (!scenario.selector) malformed.push(`${scenario.id}: integration row has no selector`);
            if (!scenario.panel || !scenario.waitFor) malformed.push(`${scenario.id}: integration row has no panel/waitFor`);
            if (!scenario.expected && !scenario.pattern
                && scenario.draftEquals === undefined && !scenario.expectRequests
                && !scenario.requires && !scenario.absent) {
                malformed.push(`${scenario.id}: integration row asserts nothing beyond its own selector`);
            }
            if (!scenario.why) malformed.push(`${scenario.id}: integration row does not say why it exists`);
        }
    }
    const integration = FEATURE_SCENARIOS.filter(s => s.reachability === 'integration');
    return {
        total: FEATURE_SCENARIOS.length,
        integration: integration.length,
        shadowed: FEATURE_SCENARIOS.filter(s => s.reachability === 'shadowed').length,
        withActions: FEATURE_SCENARIOS.filter(s => s.actions?.length).length,
        withRequestOracle: FEATURE_SCENARIOS.filter(s => s.expectRequests?.length).length,
        duplicate,
        malformed,
        scenarios: FEATURE_SCENARIOS,
        integrationScenarios: integration,
    };
}

export default FEATURE_SCENARIOS;
