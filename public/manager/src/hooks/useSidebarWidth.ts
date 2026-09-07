import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

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
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
        if (raw == null || raw.trim() === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

export function writeStoredSidebarWidth(width: number): void {
    try {
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
    } catch {
        // Storage can be unavailable; keep the in-memory preference usable.
    }
}

export function clearStoredSidebarWidth(): void {
    try {
        localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    } catch {
        // Reset still applies in memory when storage is unavailable.
    }
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
    const [preferredWidth, setPreferredWidth] = useState(() =>
        Math.max(SIDEBAR_WIDTH_MIN, readStoredSidebarWidth() ?? SIDEBAR_WIDTH_DEFAULT));
    const preferredWidthRef = useRef(preferredWidth);
    const width = clampSidebarWidth(preferredWidth, bounds);

    const addDelta = useCallback((delta: number) => {
        // Begin at the displayed width, even while space temporarily clamps it.
        const displayed = clampSidebarWidth(preferredWidthRef.current, bounds);
        const next = clampSidebarWidth(displayed + delta, bounds);
        preferredWidthRef.current = next;
        setPreferredWidth(next);
    }, [bounds.viewportWidth, bounds.rightPanelOpen, bounds.rightPanelWidth]);

    const persist = useCallback(() => {
        // onDelta and onEnd can run in one event before React renders again.
        writeStoredSidebarWidth(preferredWidthRef.current);
    }, []);

    const reset = useCallback(() => {
        clearStoredSidebarWidth();
        preferredWidthRef.current = SIDEBAR_WIDTH_DEFAULT;
        setPreferredWidth(SIDEBAR_WIDTH_DEFAULT);
    }, []);

    return { width, addDelta, persist, reset, viewportWidth };
}
