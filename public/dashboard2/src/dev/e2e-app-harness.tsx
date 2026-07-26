import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../styles/sidebar-v4.css';
import '../styles/workbench-v4.css';
import '../styles/turn-stream.css';
import '../styles/render-content.css';
import '../models/model-picker.css';
import '../features/hover-dock/hover-dock.css';
import { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ManagerApiProvider } from '../providers/api-provider.tsx';
import { DesktopBridgeProvider } from '../providers/desktop-bridge-provider.tsx';
import { ManagerPreferencesProvider } from '../providers/preferences-provider.tsx';
import { ManagerShortcutProvider } from '../providers/shortcut-provider.tsx';
import { ManagerSyncProvider } from '../providers/sync-provider.tsx';
import { AppScopeProvider, useAppScope, type AppScopeValue, type SidePanePanelType } from '../state/scope.tsx';
import { Shell } from '../shell/Shell.tsx';
import { T2_MAX_TURNS } from '../turn-stream/store/turn-store.ts';

const PORT = 3506;
const SESSION = 'wp4-e2e-session';
const BASE_TIME = 1_783_000_000_000;

type JsonRecord = Record<string, unknown>;
type FakeSource = {
    url: string;
    generation: number;
    closed: boolean;
    onmessage: ((event: MessageEvent<string>) => void) | null;
    onerror: (() => void) | null;
};

export interface E2EHarnessOptions {
    historyCount?: number;
    autoSelectSession?: boolean;
}

export interface E2EHarnessDiagnostics {
    selected: string | null;
    workspaceMode: 'chat' | 'settings';
    sidePaneOpen: boolean;
    activePanelId: string | null;
    panels: Array<{ id: string; type: SidePanePanelType; keepAlive: boolean }>;
    turnDomCount: number;
    transcriptEntries: number;
    turnStoreWindowCap: number;
    listeners: number;
    documents: number;
    requests: number;
    unknownRequests: string[];
}

/**
 * One recorded request. The old `requests: string[]` could answer "how many
 * calls happened" and nothing else, which is not enough to prove a button did
 * its job: Stop changes no pixels, so the request IS the observable. Body and
 * timestamp make `expectRequests` able to assert what was sent and to ignore
 * everything that happened before the action under test.
 */
export interface RecordedRequest {
    method: string;
    pathname: string;
    search: string;
    body: JsonRecord | null;
    at: number;
}

/**
 * How the code tab's endpoints should answer for one scenario.
 *
 * Every field defaults to the working path, so a scenario names only the one
 * thing it wants to bend. `hold*` never settles, which is the only way to
 * observe a loading frame that is otherwise a few milliseconds long.
 */
export interface CodeFixtureConfig {
    capability?: { available?: boolean; reason?: string } | null;
    holdCapability?: boolean;
    /** Hold only the ?refresh=1 probe, so the first paint is a real screen. */
    holdCapabilityRefresh?: boolean;
    models?: JsonRecord | null;
    modelsStatus?: number;
    holdModels?: boolean;
    /** Live sessions from GET /sessions. */
    liveSessions?: JsonRecord[];
    liveSessionsStatus?: number;
    /** Stored sessions from GET /sessions/stored. */
    storedSessions?: JsonRecord[];
    storedStatus?: number;
    holdStored?: boolean;
    createStatus?: number;
    loadStatus?: number;
    holdLoad?: boolean;
    promptStatus?: number;
    holdPrompt?: boolean;
    modelSwitchStatus?: number;
    holdModelSwitch?: boolean;
    permissionAnswerStatus?: number;
    /** Answer a model switch with a DIFFERENT model than the one requested. */
    modelSwitchReturns?: string;
    replayEvents?: JsonRecord[];
}

/**
 * How the employees surface should answer. The panel fans out to three
 * endpoints with `Promise.allSettled` (employees-api.ts:100): `/employees` is
 * required and a failure throws, while the two orchestrate reads degrade to a
 * warning each instead of failing. That is why each sub-request gets its own
 * independent lever — the warning states are only reachable by failing one
 * sub-request while the others succeed.
 */
export interface EmployeesFixtureConfig {
    /** /api/employees rows. */
    employees?: JsonRecord[];
    employeesStatus?: number;
    holdEmployees?: boolean;
    /** /orchestrate/workers — degrades to a warning when it fails. */
    workersStatus?: number;
    workers?: JsonRecord[];
    /** /orchestrate/worker-progress — also degrades to a warning. */
    progressStatus?: number;
    progress?: JsonRecord[];
    holdWorkers?: boolean;
    holdProgress?: boolean;
}

/**
 * How the schedule sub-view should answer. Each verb is independently
 * bendable because ScheduleView surfaces a mutation failure in the same
 * role=alert as a load failure (ScheduleView.tsx:213), and only the request
 * tells them apart. `hold*` never settles, which is the only way to observe a
 * busy row.
 */
export interface ScheduleFixtureConfig {
    items?: JsonRecord[];
    listStatus?: number;
    holdList?: boolean;
    createStatus?: number;
    holdCreate?: boolean;
    updateStatus?: number;
    holdUpdate?: boolean;
    deleteStatus?: number;
    holdDelete?: boolean;
    dispatchStatus?: number;
    /** The dispatch decision the panel renders. */
    dispatchResult?: { status?: string; message?: string; targetPort?: number | null };
    holdDispatch?: boolean;
}

/**
 * How the board should answer. The panel tracks `loading`, a shared
 * `error`, `creating` and per-task `busyIds` (BoardPanel.tsx:51-61), so each
 * verb is independently bendable to reach the in-flight frames and to split
 * the shared error's producers.
 */
export interface BoardFixtureConfig {
    tasks?: JsonRecord[];
    listStatus?: number;
    holdList?: boolean;
    createStatus?: number;
    holdCreate?: boolean;
    updateStatus?: number;
    holdUpdate?: boolean;
    deleteStatus?: number;
    holdDelete?: boolean;
}

/**
 * How the reminders surface should answer. RemindersCore tracks `loading`,
 * `loadError`, a shared `mutationError`, `creating` and per-item `busyIds`
 * (RemindersCore.tsx). The five mutation producers share one error DOM, so
 * each verb is bendable to split them by request.
 */
export interface RemindersFixtureConfig {
    items?: JsonRecord[];
    listStatus?: number;
    holdList?: boolean;
    createStatus?: number;
    holdCreate?: boolean;
    updateStatus?: number;
    holdUpdate?: boolean;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/** Never settles. The only way to hold a loading frame open for observation. */
function pending(): Response {
    return new Promise<Response>(() => { /* deliberately never settles */ }) as unknown as Response;
}

const CODE_MODEL_CATALOG: JsonRecord = {
    providers: [{ id: 'jwc', models: ['sonnet-4.6', 'opus-4.2'], efforts: ['low', 'medium', 'high'] }],
    defaultProvider: 'jwc',
    defaultModel: 'sonnet-4.6',
};

/**
 * A session shaped for `decodeCodeSessionValue`, which rejects a missing
 * status, a non-finite timestamp or an undefined modelId. A "close enough"
 * object here surfaces as an invalid_response alert three layers up, which is
 * how a fixture ends up proving an error screen it never meant to open.
 */
function codeSession(overrides: JsonRecord = {}): JsonRecord {
    return {
        sessionId: 'code-fixture-1',
        cwd: '/tmp/wp4-e2e',
        status: 'idle',
        createdAt: BASE_TIME,
        lastUsedAt: BASE_TIME,
        modelId: 'sonnet-4.6',
        ...overrides,
    };
}

function history(count: number): JsonRecord[] {
    return Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `WP4 production history row ${index + 1}`,
        cli: index % 2 === 0 ? null : 'codex',
        model: index % 2 === 0 ? null : 'gpt-5.5',
        tool_log: null,
        trace_run_id: null,
        turn_id: null,
        cost_usd: null,
        duration_ms: null,
        working_dir: '/tmp/wp4-e2e',
        created_at: new Date(BASE_TIME + index * 1_000).toISOString(),
        turn_segments: [],
    }));
}

class FakeApiRouter {
    readonly messages: JsonRecord[];
    requests: string[] = [];
    /** Structured log behind `requests`, used by the request oracle. */
    recorded: RecordedRequest[] = [];
    unknownRequests: string[] = [];
    /** Set by a test to render a specific capability screen. */
    capabilityResponse: { available?: boolean; reason?: string } | null = null;
    /** Whole-tab scenario config; see CodeFixtureConfig. */
    code: CodeFixtureConfig = {};
    /** Employees surface; see EmployeesFixtureConfig. */
    employees: EmployeesFixtureConfig = {};
    /** Schedule sub-view; see ScheduleFixtureConfig. */
    schedule: ScheduleFixtureConfig = {};
    /** Board surface; see BoardFixtureConfig. */
    board: BoardFixtureConfig = {};
    /** Reminders surface; see RemindersFixtureConfig. */
    reminders: RemindersFixtureConfig = {};
    /** Sessions created or loaded during the run, so a switch can echo them. */
    private codeSessionState = new Map<string, JsonRecord>();
    /** Set by a test to drive the file tree's empty and error branches. */
    fileTreeResponse: Record<string, unknown> | null = null;
    /** Set by a test to hold the instance list in flight (terminal loading). */
    holdInstances = false;
    /** Set by a test to return an instance with no working directory. */
    dropWorkingDir = false;
    ui: JsonRecord = {
        uiTheme: 'dark', locale: 'en', dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: { newSession: 'Meta+N', commandPalette: 'Meta+K' },
        chatLinkPreviewsEnabled: false,
    };
    worker: JsonRecord = {
        cli: 'codex', perCli: { codex: { model: 'gpt-5.5', effort: 'medium' } },
        memory: { enabled: true, flushEvery: 10, retentionDays: 30, autoReflectAfterFlush: false },
        network: { bindHost: '127.0.0.1', lanBypass: false, remoteAccess: { mode: 'off', trustProxies: false, trustForwardedFor: false, publicOriginHint: '', requireAuth: true } },
    };
    note = { path: 'daily/today.md', name: 'today.md', content: '# Today\n\nWP4 note', revision: 'r1', mtimeMs: 1, size: 18 };
    tasks: JsonRecord[] = [{ id: 'task-1', title: 'WP4 keyboard task', summary: 'Move me', detail: null, lane: 'backlog', port: PORT, threadKey: null, notePath: null, source: 'user', createdAt: new Date(BASE_TIME).toISOString(), updatedAt: new Date(BASE_TIME).toISOString() }];
    reminders: JsonRecord[] = [];

    constructor(count: number) {
        this.messages = history(count);
        try {
            const saved = sessionStorage.getItem('jaw.e2e.registry');
            if (saved) Object.assign(this.ui, JSON.parse(saved) as JsonRecord);
        } catch { /* deterministic defaults survive unavailable storage */ }
    }

    private body(input: RequestInfo | URL, init?: RequestInit): JsonRecord {
        const raw = init?.body ?? (input instanceof Request ? input.body : null);
        if (typeof raw !== 'string') return {};
        try { return JSON.parse(raw) as JsonRecord; } catch { return {}; }
    }

    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const rawUrl = input instanceof Request ? input.url : String(input);
        const url = new URL(rawUrl, window.location.href);
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const key = `${method} ${url.pathname}${url.search}`;
        this.requests.push(key);
        const payload = this.body(input, init);
        this.recorded.push({
            method,
            pathname: url.pathname,
            search: url.search,
            body: Object.keys(payload).length ? payload : null,
            at: this.recorded.length,
        });

        if (url.pathname === '/api/dashboard/instances') {
            // The terminal tab shows "Loading terminal working directory…" only
            // while this call is in flight, which is normally too short to
            // observe. `holdInstances` keeps that frame open so the branch can
            // be measured instead of inferred.
            if (this.holdInstances) {
                return new Promise<Response>(() => { /* deliberately never settles */ }) as unknown as Response;
            }
            // An instance with no workingDir is what drives the terminal's
            // "No working directory for this instance" alert; the field is
            // dropped rather than blanked, matching the real shape.
            const instance: JsonRecord = { port: PORT, label: 'WP4 fixture', status: 'online', version: 'e2e' };
            if (!this.dropWorkingDir) instance['workingDir'] = '/tmp/wp4-e2e';
            return json({ manager: null, peerDashboards: [], platform: 'darwin', instances: [instance] });
        }
        if (url.pathname === `/api/dashboard/instances/${PORT}`) return json({ ok: true, platform: 'darwin', instance: { port: PORT, label: 'WP4 fixture', workingDir: '/tmp/wp4-e2e', status: 'online', version: 'e2e' } });
        if (url.pathname === '/api/dashboard/registry') {
            if (method === 'PATCH' && payload['ui'] && typeof payload['ui'] === 'object') {
                Object.assign(this.ui, payload['ui']);
                sessionStorage.setItem('jaw.e2e.registry', JSON.stringify(this.ui));
            }
            return json({ registry: { ui: this.ui }, status: { source: 'e2e' } });
        }
        if (url.pathname === `/i/${PORT}/api/chat-sessions`) return json({ ok: true, data: { sessions: [{ id: SESSION, seq: 1, label: 'WP4 E2E', created_at: new Date(BASE_TIME).toISOString(), updated_at: new Date(BASE_TIME).toISOString(), message_count: this.messages.length }], active: SESSION } });
        if (url.pathname === `/i/${PORT}/api/messages`) return json({ ok: true, data: this.messages, pageInfo: { oldestCursor: 1, newestCursor: this.messages.length, hasMoreBefore: false, limit: this.messages.length }, snapshotEventSeq: 0 });
        if (url.pathname === `/i/${PORT}/api/message`) return json({ ok: true });
        if (url.pathname === `/i/${PORT}/api/stop`) return json({ ok: true });
        if (url.pathname === `/i/${PORT}/api/orchestrate/snapshot`) return json({ queued: [] });
        if (url.pathname === `/i/${PORT}/api/settings`) {
            if (method === 'PUT') Object.assign(this.worker, payload);
            return json({ ok: true, data: this.worker });
        }
        if (url.pathname === `/i/${PORT}/api/cli-registry`) return json({ ok: true, data: { codex: { defaultModel: 'gpt-5.5', models: ['gpt-5.5'], efforts: ['low', 'medium', 'high'] } } });
        if (url.pathname.startsWith(`/i/${PORT}/api/code/`)) return this.codeApi(url, method, payload);
        if (url.pathname === `/i/${PORT}/api/employees`
            || url.pathname === `/i/${PORT}/api/orchestrate/workers`
            || url.pathname === `/i/${PORT}/api/orchestrate/worker-progress`) {
            return this.employeesApi(url);
        }
        if (url.pathname === `/i/${PORT}/api/files`) {
            // Overridable like the capability probe: a visual gate cannot judge
            // the file tree's error or empty branch without being able to
            // produce one, and faking a directory read is the only way in.
            //
            // The status matters. The panel reads `response.ok`, so an error
            // body served as 200 parses as a successful listing with no
            // entries and renders the EMPTY branch — which is how the
            // `files-error` gate went green without ever reaching the error
            // path. `__status` rides on the override so the caller can force
            // the transport failure the component actually branches on.
            const forced = this.fileTreeResponse;
            if (forced) {
                const { __status: status, __hold: hold, ...body } = forced as { __status?: number; __hold?: boolean };
                // The panel's loading branch lasts only as long as this request,
                // so holding it open is the only way to observe that frame.
                if (hold) return new Promise<Response>(() => { /* never settles */ }) as unknown as Response;
                return json(body, typeof status === 'number' ? status : 200);
            }
            return json({ ok: true, entries: [{ name: 'fixture.txt', path: '/tmp/wp4-e2e/fixture.txt', type: 'file', size: 12 }] });
        }

        if (url.pathname.startsWith('/api/dashboard/notes/')) return this.notes(url, method, payload);
        if (url.pathname.startsWith('/api/dashboard/board/tasks')) return this.boardApi(url, method, payload);
        if (url.pathname.startsWith('/api/dashboard/reminders')) return this.reminder(url, method, payload);
        if (url.pathname.startsWith('/api/dashboard/schedule/work')) return this.scheduleApi(url, method, payload);

        this.unknownRequests.push(key);
        return json({ ok: true, data: [], items: [], sessions: [] });
    }

    /**
     * Every `/api/code/*` endpoint the tab can reach.
     *
     * Before this existed, two of these had ad-hoc answers and the rest fell
     * through to a catch-all that returned `{ok:true, data:[], items:[],
     * sessions:[]}`. That accident is worse than a 404: `/models` failed its
     * decoder loudly, but `/sessions` happened to contain `sessions: []` and
     * passed, so "no Code sessions yet" could have been the real empty state
     * or the catch-all — indistinguishable from outside.
     *
     * Response bodies here are pinned to the PRODUCTION decoders in
     * code-api-client.ts, not to `{ok:true}`. tests/unit/qa-code-fixture-contract
     * runs each one through its real decoder so this cannot drift.
     */
    private codeApi(url: URL, method: string, payload: JsonRecord): Response {
        const path = url.pathname.slice(`/i/${PORT}/api/code`.length);
        const cfg = this.code;

        if (path === '/capabilities') {
            const refresh = url.searchParams.get('refresh') === '1';
            if (cfg.holdCapability || (refresh && cfg.holdCapabilityRefresh)) return pending();
            // `capabilityResponse` predates this config and four e2e tests
            // still set it, so it keeps working and wins when both are set.
            const forced = this.capabilityResponse ?? cfg.capability;
            if (forced) return json({ ok: true, ...forced });
            return json({ ok: true, reason: 'temporarily_unavailable' });
        }

        if (path === '/models') {
            if (cfg.holdModels) return pending();
            if (cfg.modelsStatus && cfg.modelsStatus >= 400) {
                return json({ ok: false, error: 'Code models unavailable' }, cfg.modelsStatus);
            }
            return json({ ok: true, ...(cfg.models ?? CODE_MODEL_CATALOG) });
        }

        if (path === '/sessions/stored') {
            if (cfg.holdStored) return pending();
            if (cfg.storedStatus && cfg.storedStatus >= 400) {
                return json({ ok: false, error: 'stored session index unreadable' }, cfg.storedStatus);
            }
            return json({ ok: true, sessions: cfg.storedSessions ?? [] });
        }

        if (path === '/sessions/load') {
            if (cfg.holdLoad) return pending();
            if (cfg.loadStatus && cfg.loadStatus >= 400) {
                return json({ ok: false, error: 'session replay failed' }, cfg.loadStatus);
            }
            const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : 'code-fixture-1';
            const cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : '/tmp/wp4-e2e';
            const session = codeSession({
                sessionId,
                cwd,
                ...(cfg.replayEvents ? { replayEvents: cfg.replayEvents } : {}),
            });
            this.codeSessionState.set(sessionId, session);
            return json({ ok: true, session });
        }

        if (path === '/sessions' && method === 'POST') {
            if (cfg.createStatus && cfg.createStatus >= 400) {
                return json({ ok: false, error: 'unable to start a Code session' }, cfg.createStatus);
            }
            const cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : '/tmp/wp4-e2e';
            const model = typeof payload['model'] === 'string' ? payload['model'] : 'sonnet-4.6';
            const session = codeSession({ sessionId: `code-created-${this.codeSessionState.size + 1}`, cwd, modelId: model });
            this.codeSessionState.set(String(session['sessionId']), session);
            return json({ ok: true, session }, 201);
        }

        if (path === '/sessions') return json({ ok: true, sessions: cfg.liveSessions ?? [] });

        const sessionScoped = /^\/sessions\/([^/]+)(\/[a-z]+)?$/.exec(path);
        if (sessionScoped) {
            const sessionId = decodeURIComponent(sessionScoped[1]!);
            const verb = sessionScoped[2] ?? '';

            if (verb === '/model') {
                if (cfg.holdModelSwitch) return pending();
                if (cfg.modelSwitchStatus && cfg.modelSwitchStatus >= 400) {
                    return json({ ok: false, error: 'model switch rejected' }, cfg.modelSwitchStatus);
                }
                // The tab confirms the switch by matching the RETURNED modelId
                // against its options, so answering with a different model is
                // how the invalid_response path gets driven.
                const requested = typeof payload['modelId'] === 'string' ? payload['modelId'] : 'sonnet-4.6';
                const modelId = cfg.modelSwitchReturns ?? requested;
                const session = codeSession({ ...(this.codeSessionState.get(sessionId) ?? {}), sessionId, modelId });
                this.codeSessionState.set(sessionId, session);
                return json({ ok: true, session });
            }

            if (verb === '/prompt') {
                if (cfg.holdPrompt) return pending();
                if (cfg.promptStatus && cfg.promptStatus >= 400) {
                    return json({ ok: false, error: 'prompt rejected' }, cfg.promptStatus);
                }
                return json({ ok: true, accepted: true, sessionId }, 202);
            }

            // cancel, config, ext, fork, and DELETE all decode through decodeOk.
            return json({ ok: true });
        }

        if (path.startsWith('/permissions/')) {
            if (cfg.permissionAnswerStatus && cfg.permissionAnswerStatus >= 400) {
                return json({ ok: false, error: 'permission answer rejected' }, cfg.permissionAnswerStatus);
            }
            return json({ ok: true });
        }
        if (path === '/permissions') return json({ ok: true, permissions: [] });
        if (path === '/git-info') return json({ ok: true, branch: 'main', dirty: false });

        // Anything else is a genuine gap, and it must be visible as one rather
        // than absorbed by the catch-all.
        this.unknownRequests.push(`${method} ${url.pathname}${url.search}`);
        return json({ ok: false, error: `unhandled code endpoint ${path}` }, 501);
    }

    /**
     * The three reads the employees surface makes. Before this existed they
     * fell through to the catch-all's `{ok:true, data:[], items:[], sessions:[]}`,
     * which `normalizeEmployees` reads as an empty list — so "No employees
     * configured." could be the real empty state or the catch-all, exactly the
     * ambiguity that motivated the code handlers.
     *
     * Each is independently bendable because the panel degrades the two
     * orchestrate reads to warnings rather than failing, and those warnings
     * are the states under test.
     */
    private employeesApi(url: URL): Response {
        const cfg = this.employees;
        if (url.pathname.endsWith('/api/employees')) {
            if (cfg.holdEmployees) return pending();
            if (cfg.employeesStatus && cfg.employeesStatus >= 400) {
                return json({ ok: false, error: 'employee registry unreadable' }, cfg.employeesStatus);
            }
            return json(cfg.employees ?? []);
        }
        if (url.pathname.endsWith('/orchestrate/workers')) {
            if (cfg.holdWorkers) return pending();
            if (cfg.workersStatus && cfg.workersStatus >= 400) {
                return json({ ok: false, error: 'active workers unavailable' }, cfg.workersStatus);
            }
            return json(cfg.workers ?? []);
        }
        // /orchestrate/worker-progress
        if (cfg.holdProgress) return pending();
        if (cfg.progressStatus && cfg.progressStatus >= 400) {
            return json({ ok: false, error: 'worker progress unavailable' }, cfg.progressStatus);
        }
        return json({ workers: cfg.progress ?? [] });
    }

    /**
     * The schedule sub-view's CRUD plus its dispatch decision.
     *
     * The old handler matched the exact path only, so `/:id` and
     * `/:id/dispatch` fell through to the catch-all and a mutation scenario
     * would have silently measured the wrong screen.
     */
    private scheduleApi(url: URL, method: string, payload: JsonRecord): Response {
        const cfg = this.schedule;
        const rest = url.pathname.slice('/api/dashboard/schedule/work'.length);
        const item = (overrides: JsonRecord = {}): JsonRecord => ({
            id: 'sched-1',
            title: 'wp5c scheduled work',
            group: 'today',
            enabled: true,
            createdAt: new Date(BASE_TIME).toISOString(),
            updatedAt: new Date(BASE_TIME).toISOString(),
            ...overrides,
        });

        if (rest === '' || rest === '/') {
            if (method === 'GET') {
                if (cfg.holdList) return pending();
                if (cfg.listStatus && cfg.listStatus >= 400) {
                    return json({ ok: false, error: 'schedule unreadable' }, cfg.listStatus);
                }
                return json({ ok: true, items: cfg.items ?? [] });
            }
            if (method === 'POST') {
                if (cfg.holdCreate) return pending();
                if (cfg.createStatus && cfg.createStatus >= 400) {
                    return json({ ok: false, error: 'schedule create rejected' }, cfg.createStatus);
                }
                return json({ ok: true, item: item({ title: String(payload['title'] ?? 'wp5c scheduled work') }) });
            }
        }

        const match = /^\/([^/]+)(\/dispatch)?$/.exec(rest);
        if (match) {
            const id = decodeURIComponent(match[1]!);
            if (match[2] === '/dispatch') {
                if (cfg.holdDispatch) return pending();
                if (cfg.dispatchStatus && cfg.dispatchStatus >= 400) {
                    return json({ ok: false, error: 'dispatch decision failed' }, cfg.dispatchStatus);
                }
                return json({
                    ok: true,
                    item: item({ id }),
                    result: cfg.dispatchResult ?? { status: 'dispatched', message: 'Dispatched to the target worker', targetPort: PORT },
                });
            }
            if (method === 'PATCH') {
                if (cfg.holdUpdate) return pending();
                if (cfg.updateStatus && cfg.updateStatus >= 400) {
                    return json({ ok: false, error: 'schedule update rejected' }, cfg.updateStatus);
                }
                return json({ ok: true, item: item({ id, ...payload }) });
            }
            if (method === 'DELETE') {
                if (cfg.holdDelete) return pending();
                if (cfg.deleteStatus && cfg.deleteStatus >= 400) {
                    return json({ ok: false, error: 'schedule delete rejected' }, cfg.deleteStatus);
                }
                return json({ ok: true });
            }
        }
        return json({ ok: true, items: [] });
    }

    private notes(url: URL, method: string, payload: JsonRecord): Response {
        if (url.pathname.endsWith('/info')) return json({ root: '/tmp/wp4-e2e/notes' });
        if (url.pathname.endsWith('/version')) return json({ version: 1 });
        if (url.pathname.endsWith('/tree')) return json([{ path: 'daily', name: 'daily', kind: 'folder', mtimeMs: 1, size: 0, children: [{ path: this.note.path, name: this.note.name, kind: 'file', mtimeMs: 1, size: this.note.content.length }] }]);
        if (url.pathname.endsWith('/index')) return json({ version: 1, notes: [{ path: this.note.path, title: 'Today', aliases: [], tags: ['wp4'], mtimeMs: 1, size: this.note.content.length, revision: this.note.revision }], outgoingLinks: {}, backlinks: {}, unresolvedLinks: [] });
        if (url.pathname.endsWith('/search')) return json(url.searchParams.get('q')?.toLowerCase().includes('wp4') ? [{ path: this.note.path, title: 'Today', snippet: 'WP4 note', line: 3, score: 1 }] : []);
        if (url.pathname.endsWith('/file')) {
            if (method === 'PUT') {
                this.note.content = String(payload['content'] ?? this.note.content);
                this.note.revision = `r${Number(this.note.revision.slice(1)) + 1}`;
                this.note.size = this.note.content.length;
            }
            return json(this.note);
        }
        if (url.pathname.endsWith('/templates')) return json([]);
        return json({});
    }

    private boardApi(url: URL, method: string, payload: JsonRecord): Response {
        const cfg = this.board;
        if (method === 'GET') {
            if (cfg.holdList) return pending();
            if (cfg.listStatus && cfg.listStatus >= 400) {
                return json({ ok: false, error: 'board unreadable' }, cfg.listStatus);
            }
            return json({ ok: true, tasks: cfg.tasks ?? this.tasks });
        }
        const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        if (method === 'PATCH') {
            if (cfg.holdUpdate) return pending();
            if (cfg.updateStatus && cfg.updateStatus >= 400) {
                return json({ ok: false, error: 'task update rejected' }, cfg.updateStatus);
            }
            const task = this.tasks.find(item => item['id'] === id)!;
            Object.assign(task, payload, { updatedAt: new Date(BASE_TIME + 1_000).toISOString() });
            return json({ ok: true, task });
        }
        if (method === 'POST') {
            if (cfg.holdCreate) return pending();
            if (cfg.createStatus && cfg.createStatus >= 400) {
                return json({ ok: false, error: 'task create rejected' }, cfg.createStatus);
            }
            const task = { id: `task-${this.tasks.length + 1}`, title: String(payload['title']), summary: null, detail: null, lane: String(payload['lane'] ?? 'backlog'), port: PORT, threadKey: null, notePath: null, source: 'user', createdAt: new Date(BASE_TIME).toISOString(), updatedAt: new Date(BASE_TIME).toISOString() };
            this.tasks.push(task); return json({ ok: true, task });
        }
        if (method === 'DELETE') {
            if (cfg.holdDelete) return pending();
            if (cfg.deleteStatus && cfg.deleteStatus >= 400) {
                return json({ ok: false, error: 'task delete rejected' }, cfg.deleteStatus);
            }
        }
        return json({ ok: true });
    }

    private reminder(url: URL, method: string, payload: JsonRecord): Response {
        const cfg = this.reminders;
        if (method === 'GET') {
            if (cfg.holdList) return pending();
            if (cfg.listStatus && cfg.listStatus >= 400) {
                return json({ ok: false, error: 'reminders unreadable' }, cfg.listStatus);
            }
            return json({ ok: true, items: cfg.items ?? this.reminders });
        }
        if (method === 'POST') {
            if (cfg.holdCreate) return pending();
            if (cfg.createStatus && cfg.createStatus >= 400) {
                return json({ ok: false, error: 'reminder create rejected' }, cfg.createStatus);
            }
            const item = { id: `reminder-${this.reminders.length + 1}`, title: String(payload['title']), notes: '', listId: 'default', status: 'open', priority: payload['priority'] ?? 'normal', manualRank: null, dueAt: payload['dueAt'] ?? null, remindAt: null, linkedInstance: null, subtasks: [], sourceCreatedAt: new Date(BASE_TIME).toISOString(), sourceUpdatedAt: new Date(BASE_TIME).toISOString() };
            this.reminders.push(item); return json({ ok: true, item });
        }
        const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        if (method === 'PATCH') {
            if (cfg.holdUpdate) return pending();
            if (cfg.updateStatus && cfg.updateStatus >= 400) {
                return json({ ok: false, error: 'reminder update rejected' }, cfg.updateStatus);
            }
        }
        const item = this.reminders.find(candidate => candidate['id'] === id)!;
        Object.assign(item, payload, { sourceUpdatedAt: new Date(BASE_TIME + 1_000).toISOString() });
        return json({ ok: true, item });
    }
}

export class DeterministicSseController {
    private readonly sources: FakeSource[] = [];
    private nextGeneration = 0;
    private staleHandler: ((event: MessageEvent<string>) => void) | null = null;

    create(url: string): FakeSource {
        const source: FakeSource = { url, generation: ++this.nextGeneration, closed: false, onmessage: null, onerror: null };
        this.sources.push(source);
        return source;
    }
    latest(path: string): FakeSource | undefined { return [...this.sources].reverse().find(source => !source.closed && source.url.includes(path)); }
    emit(path: string, payload: JsonRecord, id = String(this.nextGeneration)): void {
        this.latest(path)?.onmessage?.({ data: JSON.stringify(payload), lastEventId: id } as MessageEvent<string>);
    }
    disconnect(path: string): number {
        const source = this.latest(path);
        if (!source) throw new Error(`No SSE source for ${path}`);
        this.staleHandler = source.onmessage;
        source.onerror?.();
        return source.generation;
    }
    emitStale(payload: JsonRecord): void { this.staleHandler?.({ data: JSON.stringify(payload), lastEventId: 'stale' } as MessageEvent<string>); }
    generation(path: string): number { return this.latest(path)?.generation ?? 0; }
    stats(): { total: number; open: number } { return { total: this.sources.length, open: this.sources.filter(source => !source.closed).length }; }
}

let root: Root | null = null;
let scopeValue: AppScopeValue | null = null;
let listenerCount = 0;
let installed = false;

function installListenerProbe(): void {
    if (installed) return;
    installed = true;
    for (const target of [window, document]) {
        const active = new Map<string, Set<EventListenerOrEventListenerObject>>();
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
            if (listener) { const set = active.get(type) ?? new Set(); if (!set.has(listener)) { set.add(listener); active.set(type, set); listenerCount += 1; } }
            if (listener) add(type, listener, options);
        }) as typeof target.addEventListener;
        target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
            if (listener && active.get(type)?.delete(listener)) listenerCount -= 1;
            if (listener) remove(type, listener, options);
        }) as typeof target.removeEventListener;
    }
}

function ScopeProbe({ autoSelect }: { autoSelect: boolean }): null {
    const scope = useAppScope();
    scopeValue = scope;
    useEffect(() => {
        if (autoSelect) void scope.guardedSelectSession(PORT, SESSION);
    }, [autoSelect, scope.guardedSelectSession]);
    return null;
}

export function mountE2EAppHarness(target: HTMLElement, options: E2EHarnessOptions = {}): void {
    root?.unmount();
    localStorage.removeItem('d2.sidepane.v1');
    installListenerProbe();
    const router = new FakeApiRouter(options.historyCount ?? 10_000);
    const sse = new DeterministicSseController();
    const nativeFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const raw = input instanceof Request ? input.url : String(input);
        const url = new URL(raw, window.location.href);
        return url.origin === window.location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/i/'))
            ? router.fetch(input, init)
            : nativeFetch(input, init);
    }) as typeof window.fetch;
    class FakeEventSource {
        readonly source: FakeSource;
        constructor(url: string | URL) { this.source = sse.create(String(url)); }
        get onmessage() { return this.source.onmessage; }
        set onmessage(value) { this.source.onmessage = value; }
        get onerror() { return this.source.onerror; }
        set onerror(value) { this.source.onerror = value as (() => void) | null; }
        close(): void { this.source.closed = true; this.source.onmessage = null; this.source.onerror = null; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource });
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });

    window.__jawE2E = {
        api: router,
        sse,
        openPanel(type, keepAlive = ['terminal', 'browser', 'notes', 'board'].includes(type), payload, key) {
            // The payload matters. Doc and Design read their whole state from
            // it, so without a way to supply one the gate could only ever see
            // their empty screens and the truncated/binary/url branches stayed
            // invisible.
            //
            // The key matters for widgets specifically: SidePane only forwards
            // a widget payload when the panel's key equals payload.panelKey.
            scopeValue?.openPanel({
                type, key: key ?? type, title: type[0]!.toUpperCase() + type.slice(1), keepAlive,
                ...(payload ? { payload } : {}),
            });
        },
        showPicker() { scopeValue?.showPanelPicker(); },
        setCapability(response) { router.capabilityResponse = response; },
        setCode(config) { router.code = config ?? {}; },
        resetCode() { router.code = {}; router.capabilityResponse = null; },
        setEmployees(config) { router.employees = config ?? {}; },
        resetEmployees() { router.employees = {}; },
        setSchedule(config) { router.schedule = config ?? {}; },
        resetSchedule() { router.schedule = {}; },
        setBoard(config) { router.board = config ?? {}; },
        resetBoard() { router.board = {}; },
        setReminders(config) { router.reminders = config ?? {}; },
        resetReminders() { router.reminders = {}; },
        markRequests() { return router.recorded.length; },
        codeRequests(since = 0) {
            return router.recorded
                .slice(since)
                .filter(entry => entry.pathname.includes('/api/code/'));
        },
        /** Every recorded request since `since`, regardless of surface. */
        allRequests(since = 0) {
            return router.recorded.slice(since);
        },
        setFileTree(response) { router.fileTreeResponse = response; },
        setHoldInstances(hold) { router.holdInstances = hold; },
        setDropWorkingDir(drop) { router.dropWorkingDir = drop; },
        setSettings() { return scopeValue?.guardedSetWorkspaceMode('settings') ?? Promise.resolve(false); },
        setChat() { return scopeValue?.guardedSetWorkspaceMode('chat') ?? Promise.resolve(false); },
        diagnostics() {
            const transcriptEntries = Number(document.querySelector('[data-testid="turn-stream-transcript"]')?.getAttribute('style')?.match(/height:\s*([\d.]+)/)?.[1] ?? 0);
            return {
                selected: scopeValue?.selected ? `${scopeValue.selected.port}/${scopeValue.selected.sessionId}` : null,
                workspaceMode: scopeValue?.workspaceMode ?? 'chat', sidePaneOpen: scopeValue?.sidePaneOpen ?? false,
                activePanelId: scopeValue?.activePanelId ?? null,
                panels: (scopeValue?.panelInstances ?? []).map(({ id, type, keepAlive }) => ({ id, type, keepAlive })),
                turnDomCount: document.querySelectorAll('.d2-turn-slot').length,
                transcriptEntries, turnStoreWindowCap: T2_MAX_TURNS, listeners: listenerCount,
                documents: 1 + document.querySelectorAll('iframe,webview').length,
                requests: router.requests.length, unknownRequests: [...router.unknownRequests],
            } satisfies E2EHarnessDiagnostics;
        },
        unmount() { root?.unmount(); root = null; scopeValue = null; },
    };

    root = createRoot(target);
    root.render(
        <ManagerApiProvider><ManagerPreferencesProvider><DesktopBridgeProvider><ManagerShortcutProvider><AppScopeProvider><ManagerSyncProvider>
            <ScopeProbe autoSelect={options.autoSelectSession !== false} /><Shell />
        </ManagerSyncProvider></AppScopeProvider></ManagerShortcutProvider></DesktopBridgeProvider></ManagerPreferencesProvider></ManagerApiProvider>,
    );
}

declare global {
    interface Window {
        __jawE2E: {
            api: FakeApiRouter;
            sse: DeterministicSseController;
            openPanel(type: SidePanePanelType, keepAlive?: boolean, payload?: Record<string, unknown>, key?: string): void;
            showPicker(): void;
            setCapability(response: { available?: boolean; reason?: string } | null): void;
            setCode(config: CodeFixtureConfig | null): void;
            resetCode(): void;
            setEmployees(config: EmployeesFixtureConfig | null): void;
            resetEmployees(): void;
            setSchedule(config: ScheduleFixtureConfig | null): void;
            resetSchedule(): void;
            setBoard(config: BoardFixtureConfig | null): void;
            resetBoard(): void;
            setReminders(config: RemindersFixtureConfig | null): void;
            resetReminders(): void;
            /** Index to pass to codeRequests so a scenario ignores mount traffic. */
            markRequests(): number;
            codeRequests(since?: number): RecordedRequest[];
            allRequests(since?: number): RecordedRequest[];
            setFileTree(response: Record<string, unknown> | null): void;
            setHoldInstances(hold: boolean): void;
            setDropWorkingDir(drop: boolean): void;
            setSettings(): Promise<boolean>;
            setChat(): Promise<boolean>;
            diagnostics(): E2EHarnessDiagnostics;
            unmount(): void;
        };
    }
}
