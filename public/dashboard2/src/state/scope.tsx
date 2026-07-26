// port is UI-context identity only — it is NOT a field of SSE turn payloads (031.4)
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    type JSX,
    type PropsWithChildren,
} from 'react';
import { fetchNotesInfo } from '../features/notes/notes-api.ts';
import { normalizeNotesPath, subscribeNotesOpen } from '../features/notes/notes-open-intent.ts';

export type SidePanePanelType =
    | 'terminal'
    | 'browser'
    | 'files'
    | 'code'
    | 'notes'
    | 'board'
    | 'reminders'
    | 'employees'
    | 'doc'
    | 'design'
    | 'diff';

export interface SidePanePanelInstance {
    id: string;
    type: SidePanePanelType;
    key: string;
    title: string;
    payload: unknown;
    keepAlive: boolean;
    ordinal: number;
    lastActiveAt: number;
}

export interface OpenPanelInput {
    type: SidePanePanelType;
    key: string;
    title: string;
    payload?: unknown;
    keepAlive?: boolean;
}

export interface SessionScope {
    port: number;
    sessionId: string;
}

export interface PendingNotesIntent {
    path: string;
    seq: number;
}

export type LeaveGuard = () => boolean | Promise<boolean>;

export const SIDE_PANE_PANEL_LIMIT = 8;
const SIDE_PANE_STORAGE_KEY = 'd2.sidepane.v1';
const RESTORABLE_PANEL_TYPES = new Set<SidePanePanelType>([
    'terminal',
    'browser',
    'files',
    'notes',
    'board',
    'reminders',
]);

export interface AppScopeState {
    selected: SessionScope | null;
    sidePaneOpen: boolean;
    expandedPorts: number[];
    panelInstances: SidePanePanelInstance[];
    activePanelId: string | null;
    panelOpenError: string | null;
    nextPanelOrdinal: number;
    workspaceMode: 'chat' | 'settings';
    pendingNotesIntent: PendingNotesIntent | null;
}

/**
 * The sidebar's shortcut-callable surface. Sidebar registers an
 * implementation; the shortcut bindings consume it. Kept narrow so the
 * sidebar does not leak its whole local state — just what the four instance
 * shortcuts need.
 */
export interface SidebarShortcutApi {
    /** Open the sidebar (if collapsed), switch to the jaw instance list, focus it. */
    focusInstances(): void;
    /** The ordered online instances, for cycling. */
    onlineInstances(): Array<{ port: number }>;
    /** Focus/expand an instance row without changing `selected`. */
    focusInstanceRow(port: number): void;
    /** The active session for an instance, if one exists. */
    activeSessionFor(port: number): string | null;
}

export interface AppScopeValue extends AppScopeState {
    toggleInstance(port: number): void;
    openSidePane(): void;
    openPanel(input: OpenPanelInput): void;
    showPanelPicker(): void;
    /**
     * The sidebar's shortcut-callable surface, registered by Sidebar so the
     * shortcut bindings (which cannot reach Sidebar's local state directly)
     * can focus the instance list and cycle instances.
     */
    registerSidebarApi(api: SidebarShortcutApi): () => void;
    sidebarApi(): SidebarShortcutApi | null;
    openNotesAt(path: string): Promise<boolean>;
    consumeNotesIntent(seq: number): void;
    registerLeaveGuard(key: string, guard: LeaveGuard): void;
    unregisterLeaveGuard(key: string): void;
    registerDirtyCheck(key: string, check: () => boolean): void;
    unregisterDirtyCheck(key: string): void;
    hasDirty(): boolean;
    guardedSelectSession(port: number, sessionId: string): Promise<boolean>;
    guardedCloseSidePane(): Promise<boolean>;
    guardedActivatePanel(id: string): Promise<boolean>;
    guardedClosePanel(id: string): Promise<boolean>;
    guardedCloseActivePanel(): Promise<boolean>;
    guardedSetWorkspaceMode(mode: 'chat' | 'settings'): Promise<boolean>;
}

export type AppScopeAction =
    | { type: 'select-session'; selected: SessionScope }
    | { type: 'toggle-instance'; port: number }
    | { type: 'open-side-pane' }
    | { type: 'close-side-pane' }
    | { type: 'open-panel'; input: OpenPanelInput; at: number }
    | { type: 'activate-panel'; id: string; at: number }
    | { type: 'close-panel'; id: string }
    | { type: 'close-active-panel' }
    | { type: 'show-panel-picker' }
    | { type: 'set-workspace-mode'; mode: 'chat' | 'settings' }
    | { type: 'set-pending-notes-intent'; intent: PendingNotesIntent }
    | { type: 'consume-notes-intent'; seq: number };

export const initialAppScopeState: AppScopeState = {
    selected: null,
    sidePaneOpen: false,
    expandedPorts: [],
    panelInstances: [],
    activePanelId: null,
    panelOpenError: null,
    nextPanelOrdinal: 1,
    workspaceMode: 'chat',
    pendingNotesIntent: null,
};

const AppScopeContext = createContext<AppScopeValue | null>(null);

interface PersistedPanelInstance {
    type: string;
    key: string;
    title: string;
    keepAlive: boolean;
    ordinal: number;
}

interface PersistedSidePaneState {
    v: 1;
    instances: PersistedPanelInstance[];
    activePanelId: string | null;
}

function isPersistedPanelInstance(value: unknown): value is PersistedPanelInstance {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const instance = value as Record<string, unknown>;
    return typeof instance['type'] === 'string'
        && typeof instance['key'] === 'string'
        && typeof instance['title'] === 'string'
        && typeof instance['keepAlive'] === 'boolean'
        && Number.isInteger(instance['ordinal'])
        && (instance['ordinal'] as number) > 0;
}

function restoreAppScopeState(): AppScopeState {
    try {
        const raw = window.localStorage.getItem(SIDE_PANE_STORAGE_KEY);
        if (!raw) return initialAppScopeState;
        const value = JSON.parse(raw) as Partial<PersistedSidePaneState>;
        if (value.v !== 1
            || !Array.isArray(value.instances)
            || !value.instances.every(isPersistedPanelInstance)
            || (value.activePanelId !== null && typeof value.activePanelId !== 'string')) {
            return initialAppScopeState;
        }
        const ordinals = value.instances.map((instance) => instance.ordinal);
        if (value.instances.length > SIDE_PANE_PANEL_LIMIT || new Set(ordinals).size !== ordinals.length) {
            return initialAppScopeState;
        }
        const panelInstances: SidePanePanelInstance[] = value.instances.flatMap((instance) => {
            if (!RESTORABLE_PANEL_TYPES.has(instance.type as SidePanePanelType)) return [];
            return [{
                id: `side-panel-${instance.ordinal}`,
                type: instance.type as SidePanePanelType,
                key: instance.key,
                title: instance.title,
                payload: null,
                keepAlive: instance.keepAlive,
                ordinal: instance.ordinal,
                lastActiveAt: instance.ordinal,
            }];
        });
        const restoredIds = new Set(panelInstances.map((instance) => instance.id));
        return {
            ...initialAppScopeState,
            panelInstances,
            activePanelId: value.activePanelId && restoredIds.has(value.activePanelId)
                ? value.activePanelId
                : panelInstances[0]?.id ?? null,
            nextPanelOrdinal: Math.max(0, ...panelInstances.map((instance) => instance.ordinal)) + 1,
        };
    } catch {
        return initialAppScopeState;
    }
}

function persistedSidePaneState(state: AppScopeState): PersistedSidePaneState {
    return {
        v: 1,
        instances: state.panelInstances.map(({ type, key, title, keepAlive, ordinal }) => ({
            type,
            key,
            title,
            keepAlive,
            ordinal,
        })),
        activePanelId: state.activePanelId,
    };
}

function defaultKeepAlive(type: SidePanePanelType): boolean {
    return type === 'terminal' || type === 'browser' || type === 'notes' || type === 'board';
}

function closePanelFromState(state: AppScopeState, id: string): AppScopeState {
    const panelInstances = state.panelInstances.filter((panel) => panel.id !== id);
    if (panelInstances.length === state.panelInstances.length) return state;
    if (state.activePanelId !== id) return { ...state, panelInstances, panelOpenError: null };
    const previous = [...panelInstances].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] ?? null;
    return {
        ...state,
        panelInstances,
        activePanelId: previous?.id ?? null,
        panelOpenError: null,
    };
}

export function scopeReducer(state: AppScopeState, action: AppScopeAction): AppScopeState {
    switch (action.type) {
        case 'select-session':
            return { ...state, selected: action.selected };
        case 'toggle-instance':
            return {
                ...state,
                expandedPorts: state.expandedPorts.includes(action.port)
                    ? state.expandedPorts.filter((port) => port !== action.port)
                    : [...state.expandedPorts, action.port],
            };
        case 'open-side-pane':
            return { ...state, sidePaneOpen: true };
        case 'close-side-pane':
            return { ...state, sidePaneOpen: false };
        case 'open-panel': {
            const existing = state.panelInstances.find(
                (panel) => panel.type === action.input.type && panel.key === action.input.key,
            );
            if (existing) {
                return {
                    ...state,
                    sidePaneOpen: true,
                    activePanelId: existing.id,
                    panelOpenError: null,
                    panelInstances: state.panelInstances.map((panel) => panel.id === existing.id
                        ? {
                            ...panel,
                            title: action.input.title,
                            payload: action.input.payload ?? null,
                            lastActiveAt: action.at,
                        }
                        : panel),
                };
            }
            if (state.panelInstances.length >= SIDE_PANE_PANEL_LIMIT) {
                return {
                    ...state,
                    sidePaneOpen: true,
                    panelOpenError: `Side pane limit reached (${SIDE_PANE_PANEL_LIMIT}). Close a panel before opening another.`,
                };
            }
            const id = `side-panel-${state.nextPanelOrdinal}`;
            const panel: SidePanePanelInstance = {
                id,
                type: action.input.type,
                key: action.input.key,
                title: action.input.title,
                payload: action.input.payload ?? null,
                keepAlive: action.input.keepAlive ?? defaultKeepAlive(action.input.type),
                ordinal: state.nextPanelOrdinal,
                lastActiveAt: action.at,
            };
            return {
                ...state,
                sidePaneOpen: true,
                panelInstances: [...state.panelInstances, panel],
                activePanelId: id,
                panelOpenError: null,
                nextPanelOrdinal: state.nextPanelOrdinal + 1,
            };
        }
        case 'activate-panel':
            if (!state.panelInstances.some((panel) => panel.id === action.id)) return state;
            return {
                ...state,
                activePanelId: action.id,
                panelOpenError: null,
                panelInstances: state.panelInstances.map((panel) => panel.id === action.id
                    ? { ...panel, lastActiveAt: action.at }
                    : panel),
            };
        case 'close-panel':
            return closePanelFromState(state, action.id);
        case 'close-active-panel':
            return state.activePanelId ? closePanelFromState(state, state.activePanelId) : state;
        case 'show-panel-picker':
            return { ...state, activePanelId: null, panelOpenError: null };
        case 'set-workspace-mode':
            return { ...state, workspaceMode: action.mode };
        case 'set-pending-notes-intent':
            return { ...state, pendingNotesIntent: action.intent };
        case 'consume-notes-intent':
            return state.pendingNotesIntent?.seq === action.seq
                ? { ...state, pendingNotesIntent: null }
                : state;
    }
}

export function AppScopeProvider(props: PropsWithChildren): JSX.Element {
    const [state, dispatch] = useReducer(scopeReducer, initialAppScopeState, restoreAppScopeState);
    const stateRef = useRef(state);
    const leaveGuards = useRef(new Map<string, LeaveGuard>());
    const dirtyChecks = useRef(new Map<string, () => boolean>());
    const notesIntentSeq = useRef(0);
    const sidebarApiRef = useRef<SidebarShortcutApi | null>(null);
    stateRef.current = state;

    const registerSidebarApi = useCallback((api: SidebarShortcutApi): (() => void) => {
        sidebarApiRef.current = api;
        return () => { if (sidebarApiRef.current === api) sidebarApiRef.current = null; };
    }, []);
    const sidebarApi = useCallback((): SidebarShortcutApi | null => sidebarApiRef.current, []);

    const registerLeaveGuard = useCallback((key: string, guard: LeaveGuard): void => {
        leaveGuards.current.set(key, guard);
    }, []);
    const unregisterLeaveGuard = useCallback((key: string): void => {
        leaveGuards.current.delete(key);
    }, []);
    const registerDirtyCheck = useCallback((key: string, check: () => boolean): void => {
        dirtyChecks.current.set(key, check);
    }, []);
    const unregisterDirtyCheck = useCallback((key: string): void => {
        dirtyChecks.current.delete(key);
    }, []);
    const hasDirty = useCallback((): boolean => {
        for (const check of dirtyChecks.current.values()) if (check()) return true;
        return false;
    }, []);
    const passLeaveGuards = useCallback(async (): Promise<boolean> => {
        for (const [key, guard] of leaveGuards.current) {
            try {
                if (!await guard()) return false;
            } catch (error) {
                console.warn(`[dashboard2:leave-guard] ${key} blocked a transition`, error);
                return false;
            }
        }
        return true;
    }, []);
    const openNotesAt = useCallback(async (path: string): Promise<boolean> => {
        const trimmed = path.trim();
        if (!trimmed) return false;
        let notesRoot: string;
        try {
            notesRoot = (await fetchNotesInfo()).root;
        } catch (error) {
            console.warn('[dashboard2:notes-open] unable to resolve notes root', error);
            return false;
        }
        const normalized = normalizeNotesPath(trimmed, notesRoot);
        if (!normalized) {
            console.warn(`[dashboard2:notes-open] ignored path outside notes root: ${trimmed}`);
            return false;
        }
        dispatch({ type: 'open-panel', input: { type: 'notes', key: 'notes', title: 'Notes', keepAlive: true }, at: Date.now() });
        dispatch({ type: 'set-pending-notes-intent', intent: { path: normalized, seq: ++notesIntentSeq.current } });
        return true;
    }, []);

    useEffect(() => {
        const onBeforeUnload = (event: BeforeUnloadEvent): void => {
            if (!hasDirty()) return;
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [hasDirty]);
    useEffect(() => subscribeNotesOpen(path => { void openNotesAt(path); }), [openNotesAt]);
    useEffect(() => {
        try {
            window.localStorage.setItem(SIDE_PANE_STORAGE_KEY, JSON.stringify(persistedSidePaneState(state)));
        } catch {
            // Persistence is best-effort; in-memory panel state remains authoritative.
        }
    }, [state.activePanelId, state.panelInstances]);

    const value = useMemo<AppScopeValue>(() => ({
        ...state,
        toggleInstance: (port) => dispatch({ type: 'toggle-instance', port }),
        openSidePane: () => dispatch({ type: 'open-side-pane' }),
        openPanel: (input) => dispatch({ type: 'open-panel', input, at: Date.now() }),
        showPanelPicker: () => dispatch({ type: 'show-panel-picker' }),
        registerSidebarApi,
        sidebarApi,
        openNotesAt,
        consumeNotesIntent: (seq) => dispatch({ type: 'consume-notes-intent', seq }),
        registerLeaveGuard,
        unregisterLeaveGuard,
        registerDirtyCheck,
        unregisterDirtyCheck,
        hasDirty,
        guardedSelectSession: async (port, sessionId) => {
            const current = stateRef.current.selected;
            if (current?.port === port && current.sessionId === sessionId) return true;
            if (!await passLeaveGuards()) return false;
            dispatch({ type: 'select-session', selected: { port, sessionId } });
            return true;
        },
        guardedCloseSidePane: async () => {
            if (!stateRef.current.sidePaneOpen) return true;
            if (!await passLeaveGuards()) return false;
            dispatch({ type: 'close-side-pane' });
            return true;
        },
        guardedActivatePanel: async (id) => {
            if (stateRef.current.activePanelId === id) return true;
            if (!stateRef.current.panelInstances.some(panel => panel.id === id)) return false;
            if (!await passLeaveGuards()) return false;
            dispatch({ type: 'activate-panel', id, at: Date.now() });
            return true;
        },
        guardedClosePanel: async (id) => {
            if (!stateRef.current.panelInstances.some(panel => panel.id === id)) return false;
            if (!await passLeaveGuards()) return false;
            dispatch({ type: 'close-panel', id });
            return true;
        },
        guardedCloseActivePanel: async () => {
            if (!stateRef.current.activePanelId) return false;
            if (!await passLeaveGuards()) return false;
            dispatch({ type: 'close-active-panel' });
            return true;
        },
        guardedSetWorkspaceMode: async (mode) => {
            if (stateRef.current.workspaceMode === mode) return true;
            if (!await passLeaveGuards()) return false;
            dispatch({ type: 'set-workspace-mode', mode });
            return true;
        },
    }), [hasDirty, openNotesAt, passLeaveGuards, registerDirtyCheck, registerLeaveGuard, state, unregisterDirtyCheck, unregisterLeaveGuard]);

    return <AppScopeContext.Provider value={value}>{props.children}</AppScopeContext.Provider>;
}

export function useAppScope(): AppScopeValue {
    const scope = useContext(AppScopeContext);
    if (!scope) throw new Error('useAppScope must be used inside AppScopeProvider');
    return scope;
}
