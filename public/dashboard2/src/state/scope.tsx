// port is UI-context identity only — it is NOT a field of SSE turn payloads (031.4)
import {
    createContext,
    useContext,
    useReducer,
    type JSX,
    type PropsWithChildren,
} from 'react';

export interface SessionScope {
    port: number;
    sessionId: string;
}

interface AppScopeState {
    selected: SessionScope | null;
    sidePaneOpen: boolean;
    expandedPorts: number[];
}

interface AppScopeValue extends AppScopeState {
    selectSession(port: number, sessionId: string): void;
    toggleInstance(port: number): void;
    openSidePane(): void;
    closeSidePane(): void;
}

type AppScopeAction =
    | { type: 'select-session'; selected: SessionScope }
    | { type: 'toggle-instance'; port: number }
    | { type: 'open-side-pane' }
    | { type: 'close-side-pane' };

const initialState: AppScopeState = {
    selected: null,
    sidePaneOpen: false,
    expandedPorts: [],
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
            return { ...state, sidePaneOpen: false };
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
