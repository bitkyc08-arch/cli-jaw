export type PanelKind =
    | 'session-list'
    | 'tool-detail'
    | 'ide-diff-preview'
    | 'help'
    | 'command-palette'
    | 'external-editor';

export type PanelSide = 'left' | 'right';

export interface PaneState {
    openPanel: PanelKind | null;
    side: PanelSide;
    preferredWidth: number;
}

const DEFAULT_EMPTY_STATES: Record<PanelKind, string> = {
    'session-list': 'No sessions yet.',
    'tool-detail': 'No tool call selected.',
    'ide-diff-preview': 'No diff preview available.',
    'help': 'No help topic selected.',
    'command-palette': 'Type to filter commands.',
    'external-editor': 'External editor is not connected.',
};

export function createPaneState(): PaneState {
    return {
        openPanel: null,
        side: 'right',
        preferredWidth: 32,
    };
}

export function openPanel(state: PaneState, panel: PanelKind, side: PanelSide = state.side): void {
    state.openPanel = panel;
    state.side = side;
}

export function closePanel(state: PaneState): void {
    state.openPanel = null;
}

export function togglePanel(state: PaneState, panel: PanelKind, side: PanelSide = state.side): void {
    if (state.openPanel === panel) {
        closePanel(state);
        return;
    }
    openPanel(state, panel, side);
}

export function getPanelEmptyState(panel: PanelKind): string {
    return DEFAULT_EMPTY_STATES[panel];
}
