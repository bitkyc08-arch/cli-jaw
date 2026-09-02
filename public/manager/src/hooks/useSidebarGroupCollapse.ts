import { useCallback, useState } from 'react';

export const SIDEBAR_GROUP_COLLAPSED_KEY = 'jaw.sidebarGroupCollapsed';

function readMap(): Record<string, boolean> {
    try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(SIDEBAR_GROUP_COLLAPSED_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const next: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'boolean') next[key] = value;
        }
        return next;
    } catch {
        return {};
    }
}

function writeMap(value: Record<string, boolean>): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(SIDEBAR_GROUP_COLLAPSED_KEY, JSON.stringify(value));
    } catch {
        // private mode
    }
}

export function useSidebarGroupCollapse(): {
    isCollapsed: (groupKey: string) => boolean;
    toggle: (groupKey: string) => void;
    toggleGroup: (groupKey: string) => void;
} {
    const [collapsedByKey, setCollapsedByKey] = useState<Record<string, boolean>>(readMap);
    const isCollapsed = useCallback((groupKey: string) => collapsedByKey[groupKey] === true, [collapsedByKey]);
    const toggle = useCallback((groupKey: string) => {
        setCollapsedByKey(prev => {
            const next = { ...prev, [groupKey]: !prev[groupKey] };
            writeMap(next);
            return next;
        });
    }, []);
    return { isCollapsed, toggle, toggleGroup: toggle };
}
