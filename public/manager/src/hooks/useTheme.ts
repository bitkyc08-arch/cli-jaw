import { useCallback, useEffect, useState } from 'react';
import type { DashboardUiTheme } from '../types';

const THEMES: DashboardUiTheme[] = ['auto', 'dark', 'light'];

function isTheme(value: unknown): value is DashboardUiTheme {
    return typeof value === 'string' && (THEMES as string[]).includes(value);
}

function readDocumentTheme(): DashboardUiTheme {
    if (typeof document === 'undefined') return 'auto';
    const value = document.documentElement.getAttribute('data-theme');
    return isTheme(value) ? value : 'auto';
}

const STORAGE_KEY = 'jaw.uiTheme';

export function applyDocumentTheme(theme: DashboardUiTheme): void {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', theme);
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_KEY, theme);
        }
    } catch {
        // Storage may be disabled in private mode; theme still applies in-memory.
    }
}

export type ThemeApi = {
    theme: DashboardUiTheme;
    resolved: 'dark' | 'light';
    setTheme: (next: DashboardUiTheme) => void;
    syncFromRegistry: (next: DashboardUiTheme | null | undefined) => void;
};

export function useTheme(persist: (theme: DashboardUiTheme) => void): ThemeApi {
    const [theme, setThemeState] = useState<DashboardUiTheme>(readDocumentTheme);
    const [resolved, setResolved] = useState<'dark' | 'light'>(() => resolveTheme(theme));

    useEffect(() => {
        applyDocumentTheme(theme);
        setResolved(resolveTheme(theme));
    }, [theme]);

    useEffect(() => {
        if (theme !== 'auto' || typeof window === 'undefined' || !window.matchMedia) {
            return undefined;
        }
        const query = window.matchMedia('(prefers-color-scheme: light)');
        const onChange = () => setResolved(query.matches ? 'light' : 'dark');
        if (typeof query.addEventListener === 'function') {
            query.addEventListener('change', onChange);
            return () => query.removeEventListener('change', onChange);
        }
        query.addListener(onChange);
        return () => query.removeListener(onChange);
    }, [theme]);

    const setTheme = useCallback((next: DashboardUiTheme) => {
        if (!isTheme(next)) return;
        setThemeState(next);
        applyDocumentTheme(next);
        setResolved(resolveTheme(next));
        persist(next);
    }, [persist]);

    const syncFromRegistry = useCallback((next: DashboardUiTheme | null | undefined) => {
        if (!isTheme(next)) return;
        setThemeState(next);
        applyDocumentTheme(next);
        setResolved(resolveTheme(next));
    }, []);

    return { theme, resolved, setTheme, syncFromRegistry };
}

export function syncThemeFromRegistry(theme: DashboardUiTheme | null | undefined): void {
    if (theme && isTheme(theme)) {
        applyDocumentTheme(theme);
    }
}

function resolveTheme(theme: DashboardUiTheme): 'dark' | 'light' {
    if (theme === 'dark') return 'dark';
    if (theme === 'light') return 'light';
    if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return 'dark';
}
