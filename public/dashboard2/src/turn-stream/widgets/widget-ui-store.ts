export type WidgetUiMode = 'expanded' | 'placeholder';
export type WidgetRevision = string | number;
export type WidgetWidthBucket = string | number;

export interface WidgetUiState {
    mode: WidgetUiMode;
    revision: WidgetRevision | null;
    widthBucket: WidgetWidthBucket | null;
}

export type WidgetUiSnapshot = Readonly<Record<string, Readonly<WidgetUiState>>>;

export interface WidgetUiStore {
    subscribe(listener: () => void): () => void;
    getSnapshot(): WidgetUiSnapshot;
    expand(widgetId: string): void;
    collapse(widgetId: string): void;
    setRevision(widgetId: string, revision: WidgetRevision | null): void;
    setWidthBucket(widgetId: string, widthBucket: WidgetWidthBucket | null): void;
}

const EMPTY_WIDGET_STATE: Readonly<WidgetUiState> = Object.freeze({
    mode: 'placeholder',
    revision: null,
    widthBucket: null,
});

export function createWidgetUiStore(): WidgetUiStore {
    let snapshot: WidgetUiSnapshot = Object.freeze({});
    const listeners = new Set<() => void>();

    function update(widgetId: string, patch: Partial<WidgetUiState>): void {
        const current = snapshot[widgetId] ?? EMPTY_WIDGET_STATE;
        const next = Object.freeze({ ...current, ...patch });
        if (current.mode === next.mode
            && current.revision === next.revision
            && current.widthBucket === next.widthBucket) return;
        snapshot = Object.freeze({ ...snapshot, [widgetId]: next });
        for (const listener of [...listeners]) listener();
    }

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        expand: widgetId => update(widgetId, { mode: 'expanded' }),
        collapse: widgetId => update(widgetId, { mode: 'placeholder' }),
        setRevision: (widgetId, revision) => update(widgetId, { revision }),
        setWidthBucket: (widgetId, widthBucket) => update(widgetId, { widthBucket }),
    };
}
