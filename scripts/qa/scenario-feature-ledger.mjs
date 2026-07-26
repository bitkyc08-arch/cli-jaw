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
    notes: { panel: 'notes', component: 'Notes', waitFor: '.d2-notes-panel' },
    board: { panel: 'board', component: 'Board', waitFor: '.d2-board-canvas, .d2-board-state, .d2-board-error' },
    reminders: { panel: 'reminders', component: 'Reminders', waitFor: '.d2-reminders-loading, .d2-reminders-error, .d2-reminders-list, .d2-reminders-empty, .d2-reminders-form' },
    employees: { panel: 'employees', component: 'Employees', waitFor: '.d2-employees-panel' },
};

/** The settings workspace is not a side-pane panel; it replaces the chat area. */
const SETTINGS = {
    component: 'Settings',
    // Opened via __jawE2E.setSettings(), and a page is chosen in the sidebar.
    openSettings: true,
    waitFor: '.d2-settings-page, .d2-settings-workspace, .d2-settings-sidebar',
};

// The side pane is narrow, which puts the board in compact mode at the
// default 1440x900 viewport: it renders one lane as a <select> instead of
// every lane (BoardPanel.tsx:96,364). A wider viewport keeps the pane wide
// enough to show all lanes, which is what the lane-level rows assert on.
const BOARD_WIDE = { width: 1920, height: 1000 };

/** A single open reminder, shaped for the adapter's list decode. */
const OPEN_REMINDER = {
    id: 'rem-1',
    title: 'wp5c open reminder',
    notes: '',
    listId: 'default',
    status: 'open',
    priority: 'normal',
    manualRank: null,
    dueAt: null,
    remindAt: null,
    linkedInstance: null,
    subtasks: [],
    sourceCreatedAt: '2026-07-26T00:00:00.000Z',
    sourceUpdatedAt: '2026-07-26T00:00:00.000Z',
};

/** A single scheduled-work item, shaped for the schedule adapter. */
const SCHED_ITEM = {
    id: 'sched-1',
    title: 'wp5c scheduled work',
    group: 'today',
    cron: '0 9 * * *',
    runAt: null,
    enabled: true,
    targetPort: 3506,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
};

export const FEATURE_SCENARIOS = [
    // ── employees ───────────────────────────────────────────────────────────
    // Three sub-requests, fan-out via Promise.allSettled. employees is
    // required; workers/progress degrade to a warning each.
    {
        id: 'employees-loading',
        branchId: 'EmployeesPanel-status-1ed2psi',
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
        why: 'a lane with tasks; in compact mode only its lane renders, so empty siblings are hidden',
        ...PANEL.board,
        viewport: BOARD_WIDE,
        levers: { board: { tasks: [{ id: 'task-1', title: 'wp5c board task', lane: 'ready' }] } },
        // The pane is always compact (max 380px), so only the selected lane
        // renders. The task sits in Todo and must be selected before it is
        // visible. Asserting a co-visible empty lane would be measuring wide
        // mode, which the side pane never reaches — that is the compact-mask
        // Volta flagged, so this row asserts the compact reality: the card
        // appears and the picker is the only lane navigation present.
        actions: [{ kind: 'select', selector: '.d2-board-lane-picker select', value: 'todo' }],
        selector: '.d2-board-panel.is-compact .d2-board-card',
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

    // ── reminders (feed) ────────────────────────────────────────────────────
    // RemindersCore tracks loading, loadError, a shared mutationError,
    // creating and per-item busyIds. delete has no producer -> shadowed.
    {
        id: 'reminders-loading',
        branchId: 'RemindersCore-loading-1br8rv0',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the list is in flight and nothing is cached',
        ...PANEL.reminders,
        levers: { reminders: { holdList: true } },
        selector: '.d2-reminders-loading[role="status"]',
        expected: 'Loading reminders',
    },
    {
        id: 'reminders-load-error',
        branchId: 'RemindersCore-loadError-hwdkwi',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the list read failed; distinct from a mutation error',
        ...PANEL.reminders,
        levers: { reminders: { listStatus: 500 } },
        selector: '.d2-reminders-error[role="alert"]',
        // The request fires on mount, before it can be marked; the alert is
        // the evidence, and there is no reminder list behind it.
        absent: '.d2-reminders-card',
    },
    {
        id: 'reminders-active-empty',
        branchId: 'RemindersCore-activeReminderslengt-yjzvbf',
        reachability: 'integration',
        axis: 'empty', target: 'StatePanel',
        why: 'the list loaded with nothing active',
        ...PANEL.reminders,
        levers: { reminders: { items: [] } },
        selector: '.d2-reminders-empty',
        expected: 'No active reminders.',
    },
    {
        id: 'reminders-create-busy',
        reachability: 'integration',
        axis: 'loading', target: 'Form',
        why: 'the create form disables its submit while the POST is in flight',
        ...PANEL.reminders,
        levers: { reminders: { items: [], holdCreate: true } },
        actions: [
            { kind: 'click', selector: 'button[aria-label="Create reminder"]' },
            { kind: 'type', selector: '.d2-reminders-form input[type="text"]', text: 'wp5c new reminder' },
            { kind: 'click', selector: '.d2-reminders-primary:not([disabled])' },
        ],
        selector: '.d2-reminders-primary[disabled]',
        expected: 'Adding',
    },
    {
        id: 'reminders-create-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the create POST was rejected; one of the shared mutationError producers',
        ...PANEL.reminders,
        levers: { reminders: { items: [], createStatus: 500 } },
        actions: [
            { kind: 'click', selector: 'button[aria-label="Create reminder"]' },
            { kind: 'type', selector: '.d2-reminders-form input[type="text"]', text: 'wp5c failing reminder' },
            { kind: 'click', selector: '.d2-reminders-primary:not([disabled])' },
        ],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/reminders', count: 1 }],
        selector: '.d2-reminders-error[role="alert"]',
    },
    {
        id: 'reminders-complete-error',
        branchId: 'RemindersCore-mutationError-3z4t2n',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'completing a reminder was rejected, behind a visible list',
        ...PANEL.reminders,
        levers: { reminders: { items: [OPEN_REMINDER], updateStatus: 500 } },
        actions: [{ kind: 'click', selector: 'button[aria-label="Complete wp5c open reminder"]' }],
        expectRequests: [{ method: 'PATCH', path: '/api/dashboard/reminders/rem-1', count: 1 }],
        selector: '.d2-reminders-error[role="alert"]',
        requires: '.d2-reminders-card',
    },
    {
        id: 'reminders-delete',
        branchId: null,
        reachability: 'shadowed',
        evidenceStatus: 'not-applicable',
        axis: null, target: null,
        why: 'no producer: reminders-api-adapter exposes list/create/update but no delete',
    },

    // ── schedule (sub-view of the reminders panel) ──────────────────────────
    // ScheduleView tracks loading, a shared error, creating and per-item
    // busyIds; dispatch yields five statuses. The panel opens on the Feed tab,
    // so every row switches to Schedule first.
    {
        id: 'schedule-loading',
        branchId: 'ScheduleView-loading-yw50h4',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the schedule list is in flight',
        ...PANEL.reminders,
        levers: { schedule: { holdList: true } },
        actions: [{ kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' }],
        selector: '.d2-reminders-loading[role="status"]',
        expected: 'Loading schedule',
    },
    {
        id: 'schedule-error',
        branchId: 'ScheduleView-error-cjtzwz',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the schedule list read failed',
        ...PANEL.reminders,
        levers: { schedule: { listStatus: 500 } },
        actions: [{ kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' }],
        selector: '.d2-schedule-view .d2-reminders-error[role="alert"]',
        absent: '.d2-reminders-schedule-row',
    },
    {
        id: 'schedule-empty',
        branchId: 'ScheduleView-loading-1bgpqm0',
        reachability: 'integration',
        axis: 'empty', target: 'StatePanel',
        why: 'the schedule list loaded with nothing in it',
        ...PANEL.reminders,
        levers: { schedule: { items: [] } },
        actions: [{ kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' }],
        // Scoped: both feed and schedule render a .d2-reminders-empty, so a
        // bare selector matches the feed's "No active reminders." instead.
        selector: '.d2-schedule-view .d2-reminders-empty',
        expected: 'No scheduled work.',
    },
    {
        id: 'schedule-ready',
        reachability: 'integration',
        axis: 'ready', target: 'List',
        why: 'scheduled rows render with their cadence',
        ...PANEL.reminders,
        levers: { schedule: { items: [SCHED_ITEM] } },
        actions: [{ kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' }],
        selector: '.d2-reminders-schedule-row',
        expected: 'wp5c scheduled work',
    },
    {
        id: 'schedule-create-busy',
        reachability: 'integration',
        axis: 'loading', target: 'Form',
        why: 'submitting the create editor disables save while the POST is in flight',
        ...PANEL.reminders,
        levers: { schedule: { items: [], holdCreate: true } },
        actions: [
            { kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' },
            { kind: 'click', selector: 'button[aria-label="Create scheduled work"]' },
            { kind: 'type', selector: '.d2-schedule-editor form > label > input', text: 'wp5c new scheduled work' },
            { kind: 'type', selector: '.d2-schedule-editor input[type="number"]', text: '3506' },
            { kind: 'click', selector: '.d2-schedule-editor .d2-reminders-primary:not([disabled])' },
        ],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/schedule/work', count: 1 }],
        selector: '.d2-schedule-editor .d2-reminders-primary[disabled]',
        expected: 'Saving',
    },
    {
        id: 'schedule-toggle-busy',
        reachability: 'integration',
        axis: 'loading', target: 'Control',
        why: 'the row disables its toggle while the PATCH is in flight',
        ...PANEL.reminders,
        levers: { schedule: { items: [SCHED_ITEM], holdUpdate: true } },
        actions: [
            { kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' },
            { kind: 'click', selector: '.d2-schedule-switch' },
        ],
        expectRequests: [{ method: 'PATCH', path: '/api/dashboard/schedule/work/sched-1', count: 1 }],
        selector: '.d2-schedule-switch input[disabled]',
    },
    {
        id: 'schedule-toggle-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'toggling enabled was rejected, behind a visible list',
        ...PANEL.reminders,
        levers: { schedule: { items: [SCHED_ITEM], updateStatus: 500 } },
        actions: [
            { kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' },
            { kind: 'click', selector: '.d2-schedule-switch' },
        ],
        expectRequests: [{ method: 'PATCH', path: '/api/dashboard/schedule/work/sched-1', count: 1 }],
        selector: '.d2-schedule-view .d2-reminders-error[role="alert"]',
        requires: '.d2-reminders-schedule-row',
    },
    {
        id: 'schedule-delete-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'deleting was rejected, behind a visible list',
        ...PANEL.reminders,
        levers: { schedule: { items: [SCHED_ITEM], deleteStatus: 500 } },
        actions: [
            { kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' },
            { kind: 'click', selector: 'button[aria-label="Edit scheduled work wp5c scheduled work"]' },
            { kind: 'click', selector: '.d2-schedule-delete' },
        ],
        expectRequests: [{ method: 'DELETE', path: '/api/dashboard/schedule/work/sched-1', count: 1 }],
        selector: '.d2-schedule-view .d2-reminders-error[role="alert"]',
    },
    {
        id: 'dispatch-dispatched',
        reachability: 'integration',
        axis: 'ready', target: 'Status',
        why: 'the dispatch decision came back as a successful claim',
        ...PANEL.reminders,
        levers: { schedule: { items: [SCHED_ITEM], dispatchResult: { status: 'dispatched', message: 'Dispatched to the target worker', targetPort: 3506 } } },
        actions: [
            { kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' },
            { kind: 'click', selector: 'button[aria-label="Dispatch 판정: wp5c scheduled work"]' },
        ],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/schedule/work/sched-1/dispatch', count: 1 }],
        selector: '.d2-schedule-dispatch-result[role="status"]',
        expected: '전달 준비 · claim 완료',
    },
    {
        id: 'dispatch-no-target',
        reachability: 'integration',
        axis: 'empty', target: 'Status',
        why: 'the decision found no target to dispatch to',
        ...PANEL.reminders,
        levers: { schedule: { items: [SCHED_ITEM], dispatchResult: { status: 'no_target', message: 'No target worker', targetPort: null } } },
        actions: [
            { kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' },
            { kind: 'click', selector: 'button[aria-label="Dispatch 판정: wp5c scheduled work"]' },
        ],
        selector: '.d2-schedule-dispatch-result[role="status"]',
        expected: '대상 없음',
    },
    {
        id: 'dispatch-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the dispatch POST failed',
        ...PANEL.reminders,
        levers: { schedule: { items: [SCHED_ITEM], dispatchStatus: 500 } },
        actions: [
            { kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' },
            { kind: 'click', selector: 'button[aria-label="Dispatch 판정: wp5c scheduled work"]' },
        ],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/schedule/work/sched-1/dispatch', count: 1 }],
        selector: '.d2-schedule-view .d2-reminders-error[role="alert"]',
    },

    // ── notes ───────────────────────────────────────────────────────────────
    // NotesPanel splits errors between the model (tree/index) and the document
    // (the open note); a 409 on save produces the conflict screen. The four
    // mutation handlers render their failure only after DEFECT-C's fix.
    {
        id: 'notes-tree-loading',
        branchId: 'NotesFileTree-propsloading-15ps4hp',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the notes tree is in flight',
        ...PANEL.notes,
        levers: { notes: { holdTree: true } },
        selector: '.d2-notes-tree-state[role="status"]',
        expected: 'Loading notes',
    },
    {
        id: 'notes-tree-empty',
        reachability: 'integration',
        axis: 'empty', target: 'StatePanel',
        why: 'the vault has no notes',
        ...PANEL.notes,
        levers: { notes: { tree: [] } },
        selector: '.d2-notes-tree-state',
        expected: 'No notes yet',
    },
    {
        id: 'notes-no-selection',
        branchId: 'NotesEmptyState-state-czimtp',
        reachability: 'integration',
        axis: 'empty', target: 'StatePanel',
        why: 'no note is selected, so the workspace shows the empty state',
        ...PANEL.notes,
        // The default fixture has one note which the panel opens on its own;
        // an empty tree is the only way to hold "no selection".
        levers: { notes: { tree: [], indexStatus: 200 } },
        selector: '.d2-notes-empty-state',
        // No note open means no editor surface at all.
        absent: '.d2-notes-textarea',
    },
    {
        id: 'notes-note-loading',
        branchId: 'NotesPanel-noteDocumentloading-1uxq4md',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'a note is open and its content is still being fetched',
        ...PANEL.notes,
        levers: { notes: { holdFile: true } },
        actions: [{ kind: 'click', selector: '.d2-notes-tree-item' }],
        selector: '.d2-notes-loading',
        expected: 'Loading note…',
    },
    {
        id: 'notes-conflict',
        branchId: 'NotesPanel-noteDocumentconflict-1a1stvt',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the note changed on disk while it was being edited, so the user must choose',
        ...PANEL.notes,
        levers: { notes: { fileConflict: true } },
        actions: [
            { kind: 'click', selector: '.d2-notes-tree-item[role="treeitem"]:has-text("daily")' },
            { kind: 'click', selector: '.d2-notes-tree-item[role="treeitem"]:has-text("today.md")' },
            { kind: 'wait', selector: '.d2-notes-textarea' },
            { kind: 'type', selector: '.d2-notes-textarea', text: '# wp5c edit\n' },
            { kind: 'click', selector: '.d2-notes-save-button:not([disabled])' },
        ],
        selector: '.d2-notes-notice.is-conflict[role="alert"]',
        pattern: 'This note changed on disk.*Reload.*Overwrite',
    },
    {
        id: 'notes-mutation-error-rename',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'a rename failure now renders (DEFECT-C) instead of an unhandled rejection',
        ...PANEL.notes,
        levers: { notes: { mutationStatus: 500 } },
        actions: [
            { kind: 'click', selector: '.d2-notes-tree-item[role="treeitem"]:has-text("daily")' },
            { kind: 'click', selector: 'button[aria-label="Rename today.md"]' },
        ],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/notes/rename', count: 1 }],
        selector: '.d2-notes-sidebar .d2-notes-notice.is-error[role="alert"]',
        requires: '.d2-notes-notice button',
    },
    {
        id: 'notes-mutation-error-create',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'a create-file failure now renders (DEFECT-C)',
        ...PANEL.notes,
        levers: { notes: { mutationStatus: 500 } },
        actions: [{ kind: 'click', selector: 'button[aria-label="Create note"]' }],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/notes/file', count: 1 }],
        selector: '.d2-notes-sidebar .d2-notes-notice.is-error[role="alert"]',
        requires: '.d2-notes-notice button',
    },
    {
        id: 'notes-mutation-error-folder',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'a create-folder failure now renders (DEFECT-C)',
        ...PANEL.notes,
        levers: { notes: { mutationStatus: 500 } },
        actions: [{ kind: 'click', selector: 'button[aria-label="Create folder"]' }],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/notes/folder', count: 1 }],
        selector: '.d2-notes-sidebar .d2-notes-notice.is-error[role="alert"]',
        requires: '.d2-notes-notice button',
    },
    {
        id: 'notes-mutation-error-trash',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'a trash failure now renders (DEFECT-C)',
        ...PANEL.notes,
        levers: { notes: { mutationStatus: 500 } },
        actions: [
            { kind: 'click', selector: '.d2-notes-tree-item[role="treeitem"]:has-text("daily")' },
            { kind: 'click', selector: 'button[aria-label="Trash today.md"]' },
        ],
        expectRequests: [{ method: 'POST', path: '/api/dashboard/notes/trash', count: 1 }],
        selector: '.d2-notes-sidebar .d2-notes-notice.is-error[role="alert"]',
        requires: '.d2-notes-notice button',
    },
    {
        id: 'notes-note-error',
        branchId: 'NotesPanel-noteDocumenterror-xor1qj',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'opening or saving a note failed; the document-side error notice',
        ...PANEL.notes,
        levers: { notes: { fileStatus: 500 } },
        actions: [
            { kind: 'click', selector: '.d2-notes-tree-item[role="treeitem"]:has-text("daily")' },
            { kind: 'click', selector: '.d2-notes-tree-item[role="treeitem"]:has-text("today.md")' },
        ],
        selector: '.d2-notes-notice.is-error[role="alert"]',
        requires: '.d2-notes-notice button',
    },
    {
        id: 'notes-tree-empty-ready',
        branchId: 'NotesFileTree-propsloading-dnxex1',
        reachability: 'integration',
        axis: 'empty', target: 'StatePanel',
        why: 'the tree finished loading with nothing in it (the not-loading twin of notes-tree-empty)',
        ...PANEL.notes,
        levers: { notes: { tree: [] } },
        selector: '.d2-notes-tree[aria-busy="false"] .d2-notes-tree-state',
        expected: 'No notes yet',
    },
    {
        id: 'notes-quick-switcher-empty',
        branchId: 'NotesQuickSwitcher-resultslength-o487mo',
        reachability: 'integration',
        axis: 'empty', target: 'List',
        why: 'the quick switcher is open with no notes to jump to',
        ...PANEL.notes,
        levers: { notes: { tree: [] } },
        // Cmd+P opens the switcher (notes-shortcuts.ts isQuickSwitcherShortcut).
        actions: [
            { kind: 'press', key: 'p', meta: true },
            { kind: 'type', selector: '.d2-notes-quick-switcher input[type="search"]', text: 'wp5c-no-such-note' },
        ],
        selector: '.d2-notes-quick-switcher .d2-notes-modal-empty',
        expected: 'No matching notes',
    },
    {
        id: 'notes-command-palette-empty',
        branchId: 'NotesCommandPalette-resultslength-to0o68',
        reachability: 'integration',
        axis: 'empty', target: 'List',
        why: 'the command palette is open and a query matches no command',
        ...PANEL.notes,
        levers: { notes: {} },
        // Cmd+Shift+P opens the palette; a query with no match shows the empty state.
        actions: [
            { kind: 'press', key: 'p', meta: true, shift: true },
            { kind: 'type', selector: '.d2-notes-modal-search input', text: 'wp5c-no-such-command' },
        ],
        selector: '.d2-notes-command-palette .d2-notes-modal-empty',
        expected: 'No matching commands',
    },
    {
        id: 'reminders-completed-empty',
        branchId: 'RemindersCore-completedRemindersle-hbacqc',
        reachability: 'integration',
        axis: 'empty', target: 'StatePanel',
        why: 'the completed section is expanded with nothing completed',
        ...PANEL.reminders,
        levers: { reminders: { items: [] } },
        actions: [{ kind: 'click', selector: '.d2-reminders-completed-toggle' }],
        selector: '.d2-reminders-completed .d2-reminders-empty',
        expected: 'No completed reminders.',
    },
    {
        id: 'schedule-editor-valid-port',
        branchId: 'ScheduleWorkEditor-validPort-50swgh',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the editor rejects a non-positive target port inline',
        ...PANEL.reminders,
        levers: { schedule: { items: [SCHED_ITEM] } },
        actions: [
            { kind: 'click', selector: '.d2-reminders-tabs button[role="tab"]:nth-child(2)' },
            { kind: 'click', selector: 'button[aria-label="Edit scheduled work wp5c scheduled work"]' },
        ],
        selector: '.d2-schedule-editor',
        requires: 'input',
    },

    // ── settings: SettingsPageShell (shared state machine) ───────────────────
    {
        id: 'settings-loading',
        reachability: 'integration',
        axis: 'loading', target: 'StatePanel',
        why: 'the registry has not answered the first load',
        ...SETTINGS,
        levers: { settingsConfig: { holdRegistry: true } },
        selector: '.d2-settings-state[role="status"]',
        expected: 'Loading settings',
    },
    {
        id: 'settings-load-error',
        reachability: 'integration',
        axis: 'error', target: 'Alert',
        why: 'the registry read failed',
        ...SETTINGS,
        levers: { settingsConfig: { registryStatus: 500 } },
        selector: '.d2-settings-state.error[role="alert"]',
        requires: '.d2-settings-state button',
    },
    {
        id: 'settings-save-success',
        reachability: 'integration',
        axis: 'ready', target: 'Toast',
        why: 'changing a dashboard field and saving shows the success toast',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        actions: [
            { kind: 'select', selector: 'select', value: 'light', nth: 0 },
            { kind: 'click', selector: '.d2-settings-save-bar .d2-settings-button.primary:not([disabled])' },
        ],
        selector: '.d2-settings-toast',
        pattern: 'settings saved',
    },
    {
        id: 'settings-save-busy',
        reachability: 'integration',
        axis: 'loading', target: 'Control',
        why: 'the save bar shows Saving… while the PATCH is in flight',
        ...SETTINGS,
        levers: { settingsConfig: { holdRegistrySave: true } },
        actions: [
            { kind: 'select', selector: 'select', value: 'light', nth: 0 },
            { kind: 'click', selector: '.d2-settings-save-bar .d2-settings-button.primary:not([disabled])' },
        ],
        selector: '.d2-settings-save-bar .d2-settings-button.primary[disabled]',
        expected: 'Saving…',
    },
    {
        id: 'settings-save-error',
        reachability: 'integration',
        axis: 'error', target: 'Toast',
        why: 'the save PATCH was rejected; error toast, dirty kept',
        ...SETTINGS,
        levers: { settingsConfig: { registrySaveStatus: 500 } },
        actions: [
            { kind: 'select', selector: 'select', value: 'light', nth: 0 },
            { kind: 'click', selector: '.d2-settings-save-bar .d2-settings-button.primary:not([disabled])' },
        ],
        expectRequests: [{ method: 'PATCH', path: '/api/dashboard/registry', count: 1 }],
        selector: '.d2-settings-toast.error, .d2-settings-toast[role="alert"]',
    },
    {
        id: 'settings-unsupported-field',
        reachability: 'integration',
        axis: 'prerequisite', target: 'Note',
        why: 'the fontSize field is unsupported, rendered disabled with a note',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        selector: '.d2-settings-workspace input[disabled]',
        requires: '[role="note"]',
    },

    // ── settings: theme / locale (saving AND applying) ───────────────────────
    // Theme save is TWO PATCHes: the shell's saveDashboardSettings, then
    // setMode -> saveRegistry (SettingsPageShell.tsx:140,150). The data-theme
    // attribute is the applied mode.
    {
        id: 'settings-theme-save-and-apply',
        reachability: 'integration',
        axis: 'ready', target: 'Control',
        why: 'saving theme to light issues two PATCHes and applies data-theme=light',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        actions: [
            { kind: 'select', selector: '#dashboard\\:3506\\:ui-uiTheme', value: 'light' },
            { kind: 'click', selector: '.d2-settings-save-bar .d2-settings-button.primary:not([disabled])' },
        ],
        // THREE PATCHes: the shell writes the whole ui slice, then setMode
        // and setLocale each write their own field (SettingsPageShell.tsx:150-151).
        expectRequests: [{ method: 'PATCH', path: '/api/dashboard/registry', count: 3 }],
        selector: 'html[data-theme="light"]',
        requires: '.d2-settings-toast',
    },
    {
        id: 'settings-locale-save-and-apply',
        reachability: 'integration',
        axis: 'ready', target: 'Control',
        why: 'saving locale to Korean issues three PATCHes and applies lang=ko',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        actions: [
            { kind: 'select', selector: '#dashboard\\:3506\\:ui-locale', value: 'ko' },
            { kind: 'click', selector: '.d2-settings-save-bar .d2-settings-button.primary:not([disabled])' },
        ],
        expectRequests: [{ method: 'PATCH', path: '/api/dashboard/registry', count: 3 }],
        selector: 'html[lang="ko"]',
        requires: '.d2-settings-toast',
    },

    // ── settings: SaveBar + dirty ────────────────────────────────────────────
    {
        id: 'settings-dirty-bar',
        reachability: 'integration',
        axis: 'prerequisite', target: 'Region',
        why: 'editing a field shows the unsaved-changes bar',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        actions: [{ kind: 'select', selector: '#dashboard\\:3506\\:ui-locale', value: 'ko' }],
        selector: '.d2-settings-save-bar[role="region"]',
        expected: 'You have unsaved changes.',
    },
    {
        id: 'settings-discard',
        reachability: 'integration',
        axis: 'ready', target: 'Control',
        why: 'Discard reverts the field and removes the bar',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        actions: [
            { kind: 'select', selector: '#dashboard\\:3506\\:ui-uiTheme', value: 'light' },
            { kind: 'click', selector: '.d2-settings-save-bar .d2-settings-button:not(.primary):not([disabled])' },
        ],
        selector: '.d2-settings-workspace',
        absent: '.d2-settings-save-bar',
    },

    // ── settings: sidebar navigation ─────────────────────────────────────────
    {
        id: 'settings-sidebar-active',
        branchId: 'SettingsSidebar',
        reachability: 'integration',
        axis: 'ready', target: 'Nav',
        why: 'the active page is marked in the sidebar',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        selector: '.d2-settings-nav-item.active[aria-current="page"]',
        expected: 'Display',
    },
    {
        id: 'settings-sidebar-search-empty',
        reachability: 'integration',
        axis: 'empty', target: 'Nav',
        why: 'a search with no match shows the empty state',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        actions: [{ kind: 'type', selector: '.d2-settings-search input', text: 'wp6-no-such-setting' }],
        selector: '.d2-settings-empty',
        expected: 'No matching settings.',
    },
    {
        id: 'settings-leave-guard-page-switch',
        reachability: 'integration',
        axis: 'prerequisite', target: 'Guard',
        why: 'switching page while dirty confirms and discards',
        ...SETTINGS,
        levers: { settingsConfig: {} },
        actions: [
            { kind: 'select', selector: '#dashboard\\:3506\\:ui-uiTheme', value: 'light' },
            { kind: 'click', selector: '.d2-settings-nav-item:not(.active)' },
        ],
        // confirm() returns true in the harness, so the navigation happens and
        // the dirty edit is discarded.
        selector: '.d2-settings-page',
        absent: '.d2-settings-save-bar',
    },
];

const EVIDENCE_STATUSES = new Set([
    'planned', 'proven', 'not-applicable', 'environment-unavailable', 'blocked',
]);
const REACHABILITIES = new Set(['integration', 'component', 'shadowed']);

/** Same contract as the code ledger: clean, audited, non-overlapping denominators. */
export function featureScenarioStatus(manifestIntegrationBranchIds = null) {
    const ids = new Set();
    const duplicate = [];
    const malformed = [];
    for (const scenario of FEATURE_SCENARIOS) {
        if (ids.has(scenario.id)) duplicate.push(scenario.id);
        ids.add(scenario.id);
        // Carry the surface the scenario measures, derived from its panel, so
        // a claim can be checked against the branch's own component. Schedule
        // shares the reminders panel but is a distinct component.
        if (!scenario.component && scenario.panel) {
            scenario.component = PANEL[scenario.panel]?.component ?? scenario.panel;
        }
        if (scenario.id.startsWith('schedule-') || scenario.id.startsWith('dispatch-')) scenario.component = 'Schedule';
        const evidence = scenario.evidenceStatus ?? 'planned';
        if (!REACHABILITIES.has(scenario.reachability)) malformed.push(`${scenario.id}: unknown reachability ${scenario.reachability}`);
        if (!EVIDENCE_STATUSES.has(evidence)) malformed.push(`${scenario.id}: unknown evidenceStatus ${evidence}`);
        if (evidence === 'not-applicable' && scenario.reachability !== 'shadowed') malformed.push(`${scenario.id}: not-applicable is only legal on a shadowed row`);
        if (scenario.reachability === 'shadowed' && evidence === 'proven') malformed.push(`${scenario.id}: a shadowed row cannot be proven`);
        if (scenario.reachability === 'integration') {
            if (!scenario.selector) malformed.push(`${scenario.id}: integration row has no selector`);
            if ((!scenario.panel && !scenario.openSettings) || !scenario.waitFor) malformed.push(`${scenario.id}: integration row has no panel/waitFor`);
            if (!scenario.expected && !scenario.pattern
                && scenario.draftEquals === undefined && !scenario.expectRequests
                && !scenario.requires && !scenario.absent) {
                malformed.push(`${scenario.id}: integration row asserts nothing beyond its own selector`);
            }
            if (!scenario.why) malformed.push(`${scenario.id}: integration row does not say why it exists`);
        }
    }
    const integration = FEATURE_SCENARIOS.filter(s => s.reachability === 'integration');
    // wp5c C-gate: every integration feature branch must be claimed by exactly
    // one scenario, and a scenario must not claim a branch that does not
    // exist. Validated against the manifest so the delegation cannot drift.
    const branchClaims = new Map();
    for (const scenario of FEATURE_SCENARIOS) {
        if (!scenario.branchId) continue;
        if (branchClaims.has(scenario.branchId)) malformed.push(`${scenario.branchId}: claimed by two scenarios`);
        branchClaims.set(scenario.branchId, scenario.id);
    }
    // wp5c C-gate round 3: a claim must name a branch in THIS domain. A
    // feature scenario claiming a code branch (e.g. CodeTabGate-state-1kxofnn)
    // would override that code branch's coverage entry and pass stale/delegated
    // checks that only look within one domain.
    if (manifestIntegrationBranchIds) {
        for (const branchId of branchClaims.keys()) {
            if (!manifestIntegrationBranchIds.has(branchId)) {
                malformed.push(`${branchId}: claimed but not an integration feature branch`);
            }
        }
    }
    return {
        total: FEATURE_SCENARIOS.length,
        integration: integration.length,
        shadowed: FEATURE_SCENARIOS.filter(s => s.reachability === 'shadowed').length,
        withActions: FEATURE_SCENARIOS.filter(s => s.actions?.length).length,
        withRequestOracle: FEATURE_SCENARIOS.filter(s => s.expectRequests?.length).length,
        duplicate,
        malformed,
        branchClaims,
        scenarios: FEATURE_SCENARIOS,
        integrationScenarios: integration,
    };
}

export default FEATURE_SCENARIOS;
