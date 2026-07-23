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

export interface AppScopeValue extends AppScopeState {
    toggleInstance(port: number): void;
    openSidePane(): void;
    openPanel(input: OpenPanelInput): void;
    showPanelPicker(): void;
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
    const [state, dispatch] = useReducer(scopeReducer, initialAppScopeState);
    const stateRef = useRef(state);
    const leaveGuards = useRef(new Map<string, LeaveGuard>());
    const dirtyChecks = useRef(new Map<string, () => boolean>());
    const notesIntentSeq = useRef(0);
    stateRef.current = state;

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

    const value = useMemo<AppScopeValue>(() => ({
        ...state,
        toggleInstance: (port) => dispatch({ type: 'toggle-instance', port }),
        openSidePane: () => dispatch({ type: 'open-side-pane' }),
        openPanel: (input) => dispatch({ type: 'open-panel', input, at: Date.now() }),
        showPanelPicker: () => dispatch({ type: 'show-panel-picker' }),
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
