// port is UI-context identity only — it is NOT a field of SSE turn payloads (031.4)
import {
    createContext,
    useContext,
    useReducer,
    type JSX,
    type PropsWithChildren,
} from 'react';

// 075 — SidePane tab types live at AppScope so the active tab survives pane close/open
export type SidePaneTab =
    | 'terminal'
    | 'browser'
    | 'files'
    | 'code'
    | 'notes'
    | 'board'
    | 'reminders';

export interface SessionScope {
    port: number;
    sessionId: string;
}

interface AppScopeState {
    selected: SessionScope | null;
    sidePaneOpen: boolean;
    expandedPorts: number[];
    activeSidePaneTab: SidePaneTab | null;
    /** Tabs that have been mounted at least once — used for keep-alive */
    mountedTabs: Set<SidePaneTab>;
    /** Central workspace mode: 'chat' (default) or 'settings' */
    workspaceMode: 'chat' | 'settings';
}

interface AppScopeValue extends AppScopeState {
    selectSession(port: number, sessionId: string): void;
    toggleInstance(port: number): void;
    openSidePane(): void;
    closeSidePane(): void;
    setActiveSidePaneTab(tab: SidePaneTab | null): void;
    setWorkspaceMode(mode: 'chat' | 'settings'): void;
}

type AppScopeAction =
    | { type: 'select-session'; selected: SessionScope }
    | { type: 'toggle-instance'; port: number }
    | { type: 'open-side-pane' }
    | { type: 'close-side-pane' }
    | { type: 'set-active-side-pane-tab'; tab: SidePaneTab | null }
    | { type: 'set-workspace-mode'; mode: 'chat' | 'settings' };

const initialState: AppScopeState = {
    selected: null,
    sidePaneOpen: false,
    expandedPorts: [],
    activeSidePaneTab: null,
    mountedTabs: new Set(),
    workspaceMode: 'chat',
};

const AppScopeContext = createContext<AppScopeValue | null>(null);

function scopeReducer(state: AppScopeState, action: AppScopeAction): AppScopeState {
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
            // Keep activeSidePaneTab so it restores on reopen
            return { ...state, sidePaneOpen: false };
        case 'set-active-side-pane-tab': {
            if (action.tab === null) {
                return { ...state, activeSidePaneTab: null };
            }
            const nextMounted = new Set(state.mountedTabs);
            nextMounted.add(action.tab);
            return {
                ...state,
                activeSidePaneTab: action.tab,
                mountedTabs: nextMounted,
            };
        }
        case 'set-workspace-mode':
            return { ...state, workspaceMode: action.mode };
    }
}

export function AppScopeProvider(props: PropsWithChildren): JSX.Element {
    const [state, dispatch] = useReducer(scopeReducer, initialState);
    const value: AppScopeValue = {
        ...state,
        selectSession: (port, sessionId) => dispatch({
            type: 'select-session',
            selected: { port, sessionId },
        }),
        toggleInstance: (port) => dispatch({ type: 'toggle-instance', port }),
        openSidePane: () => dispatch({ type: 'open-side-pane' }),
        closeSidePane: () => dispatch({ type: 'close-side-pane' }),
        setActiveSidePaneTab: (tab) => dispatch({ type: 'set-active-side-pane-tab', tab }),
        setWorkspaceMode: (mode) => dispatch({ type: 'set-workspace-mode', mode }),
    };

    return <AppScopeContext.Provider value={value}>{props.children}</AppScopeContext.Provider>;
}

export function useAppScope(): AppScopeValue {
    const scope = useContext(AppScopeContext);
    if (!scope) {
        throw new Error('useAppScope must be used inside AppScopeProvider');
    }
    return scope;
}
