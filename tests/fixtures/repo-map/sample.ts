export interface WidgetConfig {
    label: string;
}

export type WidgetId = string;

export enum WidgetMode {
    Compact = 'compact',
}

export const widgetLimit = 3;

export function createWidget(config: WidgetConfig): WidgetId {
    return config.label;
}

export class WidgetRegistry {
    register(id: WidgetId) {
        return createWidget({ label: id });
    }

    find(id: WidgetId) {
        return id;
    }
}
