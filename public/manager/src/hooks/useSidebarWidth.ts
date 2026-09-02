import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export const SIDEBAR_WIDTH_STORAGE_KEY = 'jaw.sidebarWidth';
export const SIDEBAR_WIDTH_DEFAULT = 300;
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_MAIN_CONTENT_MIN_WIDTH = 640;
export const SIDEBAR_COLLAPSED_WIDTH = 44;

export type SidebarWidthBounds = {
    viewportWidth: number;
    rightPanelOpen: boolean;
    rightPanelWidth: number;
};

export function resolveSidebarMaxWidth(bounds: SidebarWidthBounds): number {
    const reserved = SIDEBAR_MAIN_CONTENT_MIN_WIDTH
        + (bounds.rightPanelOpen ? Math.max(0, bounds.rightPanelWidth) : 0);
    return Math.max(SIDEBAR_WIDTH_MIN, Math.floor(bounds.viewportWidth) - reserved);
}

export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
    const max = resolveSidebarMaxWidth(bounds);
    const n = Number.isFinite(width) ? Math.round(width) : SIDEBAR_WIDTH_DEFAULT;
    return Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, n));
}

export function resolveSidebarWidth(stored: number | null, bounds: SidebarWidthBounds): number {
    const preferred = stored == null ? SIDEBAR_WIDTH_DEFAULT : Math.max(SIDEBAR_WIDTH_MIN, stored);
    return clampSidebarWidth(preferred, bounds);
}

export function readStoredSidebarWidth(): number | null {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

export function writeStoredSidebarWidth(width: number): void {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
}

export function clearStoredSidebarWidth(): void {
    localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
}

function subscribeViewport(onStoreChange: () => void): () => void {
    window.addEventListener('resize', onStoreChange);
    return () => window.removeEventListener('resize', onStoreChange);
}

function getViewportWidth(): number {
    return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

export function useSidebarWidth(args: { rightPanelOpen: boolean; rightPanelWidth: number }) {
    const viewportWidth = useSyncExternalStore(subscribeViewport, getViewportWidth, () => 1440);
    const bounds: SidebarWidthBounds = {
        viewportWidth,
        rightPanelOpen: args.rightPanelOpen,
        rightPanelWidth: args.rightPanelWidth,
    };
    const [width, setWidth] = useState(() => resolveSidebarWidth(readStoredSidebarWidth(), bounds));

    useEffect(() => {
        setWidth(current => clampSidebarWidth(current, bounds));
    }, [bounds.viewportWidth, bounds.rightPanelOpen, bounds.rightPanelWidth]);

    const addDelta = useCallback((delta: number) => {
        setWidth(current => clampSidebarWidth(current + delta, bounds));
    }, [bounds.viewportWidth, bounds.rightPanelOpen, bounds.rightPanelWidth]);

    const persist = useCallback(() => {
        setWidth(current => {
            const next = clampSidebarWidth(current, bounds);
            writeStoredSidebarWidth(next);
            return next;
        });
    }, [bounds.viewportWidth, bounds.rightPanelOpen, bounds.rightPanelWidth]);

    const reset = useCallback(() => {
        clearStoredSidebarWidth();
        setWidth(resolveSidebarWidth(null, bounds));
    }, [bounds.viewportWidth, bounds.rightPanelOpen, bounds.rightPanelWidth]);

    return { width, addDelta, persist, reset, viewportWidth };
}
