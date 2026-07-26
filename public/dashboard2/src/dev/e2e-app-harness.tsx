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

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
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
    unknownRequests: string[] = [];
    /** Set by a test to render a specific capability screen. */
    capabilityResponse: { available?: boolean; reason?: string } | null = null;
    /** Set by a test to drive the file tree's empty and error branches. */
    fileTreeResponse: Record<string, unknown> | null = null;
    /** Set by a test to hold the instance list in flight (terminal loading). */
    holdInstances = false;
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

        if (url.pathname === '/api/dashboard/instances') {
            // The terminal tab shows "Loading terminal working directory…" only
            // while this call is in flight, which is normally too short to
            // observe. `holdInstances` keeps that frame open so the branch can
            // be measured instead of inferred.
            if (this.holdInstances) {
                return new Promise<Response>(() => { /* deliberately never settles */ }) as unknown as Response;
            }
            return json({ manager: null, peerDashboards: [], platform: 'darwin', instances: [{ port: PORT, label: 'WP4 fixture', workingDir: '/tmp/wp4-e2e', status: 'online', version: 'e2e' }] });
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
        if (url.pathname === `/i/${PORT}/api/code/capabilities`) {
            // Overridable so a test can render the other capability screens.
            // Uninstalling jwc to see `missing_binary` is not an option, and the
            // router intercepts window.fetch, so Playwright's own request
            // interception never sees this call.
            const forced = this.capabilityResponse;
            if (forced) return json({ ok: true, ...forced });
            return json({ ok: true, reason: 'temporarily_unavailable' });
        }
        if (url.pathname === `/i/${PORT}/api/code/sessions/stored`) return json({ ok: true, sessions: [] });
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
                const { __status: status, ...body } = forced as { __status?: number };
                return json(body, typeof status === 'number' ? status : 200);
            }
            return json({ ok: true, entries: [{ name: 'fixture.txt', path: '/tmp/wp4-e2e/fixture.txt', type: 'file', size: 12 }] });
        }

        if (url.pathname.startsWith('/api/dashboard/notes/')) return this.notes(url, method, payload);
        if (url.pathname.startsWith('/api/dashboard/board/tasks')) return this.board(url, method, payload);
        if (url.pathname.startsWith('/api/dashboard/reminders')) return this.reminder(url, method, payload);
        if (url.pathname === '/api/dashboard/schedule/work') return json({ ok: true, items: [] });

        this.unknownRequests.push(key);
        return json({ ok: true, data: [], items: [], sessions: [] });
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

    private board(url: URL, method: string, payload: JsonRecord): Response {
        if (method === 'GET') return json({ ok: true, tasks: this.tasks });
        const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        if (method === 'PATCH') {
            const task = this.tasks.find(item => item['id'] === id)!;
            Object.assign(task, payload, { updatedAt: new Date(BASE_TIME + 1_000).toISOString() });
            return json({ ok: true, task });
        }
        if (method === 'POST') {
            const task = { id: `task-${this.tasks.length + 1}`, title: String(payload['title']), summary: null, detail: null, lane: String(payload['lane'] ?? 'backlog'), port: PORT, threadKey: null, notePath: null, source: 'user', createdAt: new Date(BASE_TIME).toISOString(), updatedAt: new Date(BASE_TIME).toISOString() };
            this.tasks.push(task); return json({ ok: true, task });
        }
        return json({ ok: true });
    }

    private reminder(url: URL, method: string, payload: JsonRecord): Response {
        if (method === 'GET') return json({ ok: true, items: this.reminders });
        if (method === 'POST') {
            const item = { id: `reminder-${this.reminders.length + 1}`, title: String(payload['title']), notes: '', listId: 'default', status: 'open', priority: payload['priority'] ?? 'normal', manualRank: null, dueAt: payload['dueAt'] ?? null, remindAt: null, linkedInstance: null, subtasks: [], sourceCreatedAt: new Date(BASE_TIME).toISOString(), sourceUpdatedAt: new Date(BASE_TIME).toISOString() };
            this.reminders.push(item); return json({ ok: true, item });
        }
        const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
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
        openPanel(type, keepAlive = ['terminal', 'browser', 'notes', 'board'].includes(type), payload) {
            // The payload matters. Doc and Design read their whole state from
            // it, so without a way to supply one the gate could only ever see
            // their empty screens and the truncated/binary/url branches stayed
            // invisible.
            scopeValue?.openPanel({
                type, key: type, title: type[0]!.toUpperCase() + type.slice(1), keepAlive,
                ...(payload ? { payload } : {}),
            });
        },
        showPicker() { scopeValue?.showPanelPicker(); },
        setCapability(response) { router.capabilityResponse = response; },
        setFileTree(response) { router.fileTreeResponse = response; },
        setHoldInstances(hold) { router.holdInstances = hold; },
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
            openPanel(type: SidePanePanelType, keepAlive?: boolean, payload?: Record<string, unknown>): void;
            showPicker(): void;
            setCapability(response: { available?: boolean; reason?: string } | null): void;
            setFileTree(response: Record<string, unknown> | null): void;
            setHoldInstances(hold: boolean): void;
            setSettings(): Promise<boolean>;
            setChat(): Promise<boolean>;
            diagnostics(): E2EHarnessDiagnostics;
            unmount(): void;
        };
    }
}
