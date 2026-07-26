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
