export type WidgetUiMode = 'inline' | 'placeholder' | 'panel'; // panel is reserved for 075 SidePane; no runtime action yet.
export type WidgetRevision = string | number;
export type WidgetWidthBucket = string | number;

export interface WidgetUiState {
    mode: WidgetUiMode;
    revision: WidgetRevision | null;
    widthBucket: WidgetWidthBucket | null;
    manualCollapseKey: string | null;
}

export type WidgetUiSnapshot = Readonly<Record<string, Readonly<WidgetUiState>>>;

export interface WidgetUiStore {
    subscribe(listener: () => void): () => void;
    getSnapshot(): WidgetUiSnapshot;
    expand(widgetId: string): void;
    collapse(widgetId: string, latchKey?: string): void;
    isManuallyCollapsed(widgetId: string, latchKey: string): boolean;
    setRevision(widgetId: string, revision: WidgetRevision | null): void;
    setWidthBucket(widgetId: string, widthBucket: WidgetWidthBucket | null): void;
}

const EMPTY_WIDGET_STATE: Readonly<WidgetUiState> = Object.freeze({
    mode: 'placeholder',
    revision: null,
    widthBucket: null,
    manualCollapseKey: null,
});

export function createWidgetUiStore(): WidgetUiStore {
    let snapshot: WidgetUiSnapshot = Object.freeze({});
    const listeners = new Set<() => void>();

    function update(widgetId: string, patch: Partial<WidgetUiState>): void {
        const current = snapshot[widgetId] ?? EMPTY_WIDGET_STATE;
        const next = Object.freeze({ ...current, ...patch });
        if (current.mode === next.mode
            && current.revision === next.revision
            && current.widthBucket === next.widthBucket
            && current.manualCollapseKey === next.manualCollapseKey) return;
        snapshot = Object.freeze({ ...snapshot, [widgetId]: next });
        for (const listener of [...listeners]) listener();
    }

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        expand: widgetId => update(widgetId, { mode: 'inline', manualCollapseKey: null }),
        collapse: (widgetId, latchKey) => update(widgetId, { mode: 'placeholder', manualCollapseKey: latchKey ?? null }),
        isManuallyCollapsed: (widgetId, latchKey) => snapshot[widgetId]?.manualCollapseKey === latchKey,
        setRevision: (widgetId, revision) => update(widgetId, { revision }),
        setWidthBucket: (widgetId, widthBucket) => update(widgetId, { widthBucket }),
    };
}
