export type PanelKind = 'doc' | 'design' | 'diff';

export type PanelTabState = {
    id: string;
    kind: PanelKind;
    title: string;
    resource?: string;
    active: boolean;
    lastAccessedAt: number;
};

export type ResourcePolicy = {
    maxTabs: number;
    evictStrategy: 'lru' | 'none';
    suspendOnHide: boolean;
};

export const DEFAULT_PANEL_RESOURCE_POLICY: ResourcePolicy = {
    maxTabs: 8,
    evictStrategy: 'lru',
    suspendOnHide: true,
};
