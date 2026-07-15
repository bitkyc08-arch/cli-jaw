import type { WidgetPanelPayload } from './widget-panel-key.ts';

export type WidgetUiMode = 'inline' | 'placeholder' | 'panel';
export type WidgetReturnMode = Exclude<WidgetUiMode, 'panel'>;
export type WidgetHandoffPhase = 'idle' | 'queued' | 'dispatched' | 'mounting';
export type WidgetRevision = string | number;
export type WidgetWidthBucket = string | number;

export interface WidgetUiState {
    mode: WidgetUiMode;
    revision: WidgetRevision | null;
    widthBucket: WidgetWidthBucket | null;
    handoff: WidgetHandoffPhase;
    request: WidgetPanelPayload | null;
    returnMode: WidgetReturnMode;
}

export interface WidgetRowUiState {
    manualCollapseKey: string | null;
}

export type WidgetUiSnapshot = Readonly<Record<string, Readonly<WidgetUiState>>>;
export type WidgetRowUiSnapshot = Readonly<Record<string, Readonly<WidgetRowUiState>>>;

export interface WidgetUiStore {
    subscribe(listener: () => void): () => void;
    getSnapshot(): WidgetUiSnapshot;
    getRowSnapshot(): WidgetRowUiSnapshot;
    expand(panelKey: string, rowKey: string): void;
    collapse(panelKey: string, rowKey: string, latchKey?: string): void;
    isManuallyCollapsed(rowKey: string, latchKey: string): boolean;
    setRevision(panelKey: string, revision: WidgetRevision | null): void;
    setWidthBucket(panelKey: string, widthBucket: WidgetWidthBucket | null): void;
    requestPromotion(payload: WidgetPanelPayload, returnMode: WidgetReturnMode): void;
    markPromotionDispatched(panelKey: string): void;
    reconcilePanelInstances(panelKeys: ReadonlySet<string>, panelOpenError: string | null): void;
    promote(panelKey: string): void;
    leavePanel(panelKey: string): void;
}

const EMPTY_WIDGET_STATE: Readonly<WidgetUiState> = Object.freeze({
    mode: 'placeholder',
    revision: null,
    widthBucket: null,
    handoff: 'idle',
    request: null,
    returnMode: 'placeholder',
});

const EMPTY_ROW_STATE: Readonly<WidgetRowUiState> = Object.freeze({
    manualCollapseKey: null,
});

export function createWidgetUiStore(): WidgetUiStore {
    let snapshot: WidgetUiSnapshot = Object.freeze({});
    let rowSnapshot: WidgetRowUiSnapshot = Object.freeze({});
    const listeners = new Set<() => void>();

    function emit(): void {
        for (const listener of [...listeners]) listener();
    }

    function update(panelKey: string, patch: Partial<WidgetUiState>): void {
        const current = snapshot[panelKey] ?? EMPTY_WIDGET_STATE;
        const next = Object.freeze({ ...current, ...patch });
        if (current.mode === next.mode
            && current.revision === next.revision
            && current.widthBucket === next.widthBucket
            && current.handoff === next.handoff
            && current.request === next.request
            && current.returnMode === next.returnMode) return;
        snapshot = Object.freeze({ ...snapshot, [panelKey]: next });
        emit();
    }

    function updateRow(rowKey: string, patch: Partial<WidgetRowUiState>): void {
        const current = rowSnapshot[rowKey] ?? EMPTY_ROW_STATE;
        const next = Object.freeze({ ...current, ...patch });
        if (current.manualCollapseKey === next.manualCollapseKey) return;
        rowSnapshot = Object.freeze({ ...rowSnapshot, [rowKey]: next });
        emit();
    }

    function settleHandoff(panelKey: string, mode: WidgetReturnMode): void {
        const current = snapshot[panelKey];
        if (!current || (current.mode !== 'panel' && current.handoff === 'idle')) return;
        update(panelKey, {
            mode,
            handoff: 'idle',
            request: null,
        });
    }

    function leavePanel(panelKey: string): void {
        settleHandoff(panelKey, 'inline');
    }

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        getRowSnapshot: () => rowSnapshot,
        expand(panelKey, rowKey) {
            const current = snapshot[panelKey];
            if (current?.mode !== 'panel') update(panelKey, { mode: 'inline', returnMode: 'inline' });
            updateRow(rowKey, { manualCollapseKey: null });
        },
        collapse(panelKey, rowKey, latchKey) {
            const current = snapshot[panelKey];
            if (current?.mode !== 'panel') update(panelKey, { mode: 'placeholder', returnMode: 'placeholder' });
            updateRow(rowKey, { manualCollapseKey: latchKey ?? null });
        },
        isManuallyCollapsed: (rowKey, latchKey) => rowSnapshot[rowKey]?.manualCollapseKey === latchKey,
        setRevision: (panelKey, revision) => update(panelKey, { revision }),
        setWidthBucket: (panelKey, widthBucket) => update(panelKey, { widthBucket }),
        requestPromotion(payload, returnMode) {
            const current = snapshot[payload.panelKey] ?? EMPTY_WIDGET_STATE;
            if (current.handoff !== 'idle') return;
            update(payload.panelKey, {
                mode: current.mode === 'panel' ? 'panel' : returnMode,
                returnMode: current.mode === 'panel' ? current.returnMode : returnMode,
                handoff: 'queued',
                request: payload,
                revision: payload.descriptor.revision,
            });
        },
        markPromotionDispatched(panelKey) {
            if (snapshot[panelKey]?.handoff === 'queued') update(panelKey, { handoff: 'dispatched' });
        },
        reconcilePanelInstances(panelKeys, panelOpenError) {
            for (const [panelKey, state] of Object.entries(snapshot)) {
                const present = panelKeys.has(panelKey);
                if (state.handoff === 'dispatched') {
                    if (present) update(panelKey, { handoff: 'mounting' });
                    else if (panelOpenError) settleHandoff(panelKey, state.returnMode);
                    continue;
                }
                if (!present && (state.mode === 'panel' || state.handoff === 'mounting')) leavePanel(panelKey);
            }
        },
        promote(panelKey) {
            if (snapshot[panelKey]?.handoff !== 'mounting') return;
            update(panelKey, { mode: 'panel', handoff: 'idle', request: null });
        },
        leavePanel,
    };
}

export const widgetUiStore = createWidgetUiStore();
