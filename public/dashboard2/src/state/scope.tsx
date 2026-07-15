// port is UI-context identity only — it is NOT a field of SSE turn payloads (031.4)
import {
    createContext,
    useContext,
    useReducer,
    type JSX,
    type PropsWithChildren,
} from 'react';

export type SidePanePanelType =
    | 'terminal'
    | 'browser'
    | 'files'
    | 'code'
    | 'notes'
    | 'board'
    | 'reminders'
    | 'doc'
    | 'design';

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
}

interface AppScopeValue extends AppScopeState {
    selectSession(port: number, sessionId: string): void;
    toggleInstance(port: number): void;
    openSidePane(): void;
    closeSidePane(): void;
    openPanel(input: OpenPanelInput): void;
    activatePanel(id: string): void;
    closePanel(id: string): void;
    closeActivePanel(): void;
    showPanelPicker(): void;
    setWorkspaceMode(mode: 'chat' | 'settings'): void;
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
    | { type: 'set-workspace-mode'; mode: 'chat' | 'settings' };

export const initialAppScopeState: AppScopeState = {
    selected: null,
    sidePaneOpen: false,
    expandedPorts: [],
    panelInstances: [],
    activePanelId: null,
    panelOpenError: null,
    nextPanelOrdinal: 1,
    workspaceMode: 'chat',
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
    }
}

export function AppScopeProvider(props: PropsWithChildren): JSX.Element {
    const [state, dispatch] = useReducer(scopeReducer, initialAppScopeState);
    const value: AppScopeValue = {
        ...state,
        selectSession: (port, sessionId) => dispatch({ type: 'select-session', selected: { port, sessionId } }),
        toggleInstance: (port) => dispatch({ type: 'toggle-instance', port }),
        openSidePane: () => dispatch({ type: 'open-side-pane' }),
        closeSidePane: () => dispatch({ type: 'close-side-pane' }),
        openPanel: (input) => dispatch({ type: 'open-panel', input, at: Date.now() }),
        activatePanel: (id) => dispatch({ type: 'activate-panel', id, at: Date.now() }),
        closePanel: (id) => dispatch({ type: 'close-panel', id }),
        closeActivePanel: () => dispatch({ type: 'close-active-panel' }),
        showPanelPicker: () => dispatch({ type: 'show-panel-picker' }),
        setWorkspaceMode: (mode) => dispatch({ type: 'set-workspace-mode', mode }),
    };

    return <AppScopeContext.Provider value={value}>{props.children}</AppScopeContext.Provider>;
}

export function useAppScope(): AppScopeValue {
    const scope = useContext(AppScopeContext);
    if (!scope) throw new Error('useAppScope must be used inside AppScopeProvider');
    return scope;
}
