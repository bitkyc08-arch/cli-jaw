import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type PropsWithChildren,
} from 'react';
import type {
    DashboardRegistry,
    DashboardRegistryPatch,
    DashboardUiTheme,
    DashboardLocale,
} from '../../../../src/manager/types.ts';

export const SHORTCUT_ACTIONS = [
    'focusInstances',
    'focusActiveSession',
    'newSession',
    'commandPalette',
    'focusNotes',
    'previousInstance',
    'nextInstance',
] as const;

export type ShortcutAction = typeof SHORTCUT_ACTIONS[number];
export type ShortcutKeymap = Record<ShortcutAction, string>;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export const DEFAULT_SHORTCUT_KEYMAP: ShortcutKeymap = {
    focusInstances: 'Alt+I',
    focusActiveSession: 'Alt+P',
    newSession: isMac ? 'Meta+N' : 'Control+N',
    commandPalette: isMac ? 'Meta+K' : 'Control+K',
    focusNotes: 'Alt+N',
    previousInstance: 'Alt+K',
    nextInstance: 'Alt+J',
};

interface DashboardRegistryLoadResult {
    registry: DashboardRegistry;
    status: unknown;
}

export interface PreferencesRegistryClient {
    load(): Promise<DashboardRegistryLoadResult>;
    patch(patch: DashboardRegistryPatch): Promise<DashboardRegistryLoadResult>;
}

async function requestRegistry(
    fetchImpl: typeof fetch,
    init?: RequestInit,
): Promise<DashboardRegistryLoadResult> {
    const response = await fetchImpl('/api/dashboard/registry', init);
    if (!response.ok) {
        throw new Error(`Registry request failed (${response.status})`);
    }
    return response.json() as Promise<DashboardRegistryLoadResult>;
}

export function createPreferencesRegistryClient(
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): PreferencesRegistryClient {
    return {
        load: () => requestRegistry(fetchImpl, {
            headers: { Accept: 'application/json' },
        }),
        patch: (patch) => requestRegistry(fetchImpl, {
            method: 'PATCH',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(patch),
        }),
    };
}

interface ThemePreferences {
    mode: DashboardUiTheme;
    resolved: Exclude<DashboardUiTheme, 'auto'>;
    setMode(mode: DashboardUiTheme): void;
}

interface LocalePreferences {
    locale: DashboardLocale;
    setLocale(locale: DashboardLocale): void;
}

interface ShortcutPreferences {
    shortcutsEnabled: boolean;
    keymap: ShortcutKeymap;
    setShortcutsEnabled(enabled: boolean): void;
    setKeymap(keymap: ShortcutKeymap): void;
}
interface LinkPreviewPreferences { enabled: boolean; setEnabled(enabled: boolean): void }

export interface ManagerPreferences {
    hydrated: boolean;
    theme: ThemePreferences;
    locale: LocalePreferences;
    shortcuts: ShortcutPreferences;
    linkPreviews: LinkPreviewPreferences;
}

type ManagerPreferencesProviderProps = PropsWithChildren<{
    client?: PreferencesRegistryClient;
}>;

const PreferencesContext = createContext<ManagerPreferences | null>(null);

function normalizeTheme(value: unknown): DashboardUiTheme {
    return value === 'dark' || value === 'light' || value === 'auto' ? value : 'auto';
}

function readStoredTheme(): DashboardUiTheme {
    if (typeof localStorage === 'undefined') return 'auto';
    try {
        return normalizeTheme(localStorage.getItem('jaw.uiTheme'));
    } catch {
        return 'auto';
    }
}

function normalizeKeymap(value: unknown): ShortcutKeymap {
    const input = value && typeof value === 'object'
        ? value as Partial<Record<ShortcutAction, unknown>>
        : {};
    return Object.fromEntries(SHORTCUT_ACTIONS.map((action) => {
        const shortcut = input[action];
        return [
            action,
            typeof shortcut === 'string' && shortcut.trim()
                ? shortcut
                : DEFAULT_SHORTCUT_KEYMAP[action],
        ];
    })) as ShortcutKeymap;
}

function systemTheme(query: MediaQueryList): 'dark' | 'light' {
    return query.matches ? 'dark' : 'light';
}

export function ManagerPreferencesProvider(
    props: ManagerPreferencesProviderProps,
): JSX.Element {
    const client = useMemo(
        () => props.client ?? createPreferencesRegistryClient(),
        [props.client],
    );
    const [hydrated, setHydrated] = useState(false);
    const hydratedRef = useRef(false);
    const [mode, setModeState] = useState<DashboardUiTheme>(readStoredTheme);
    const [resolved, setResolved] = useState<'dark' | 'light'>(() => (
        typeof matchMedia === 'undefined'
            ? 'light'
            : systemTheme(matchMedia('(prefers-color-scheme: dark)'))
    ));
    const [locale, setLocaleState] = useState<DashboardLocale>('ko');
    const [shortcutsEnabled, setShortcutsEnabledState] = useState(true);
    const [keymap, setKeymapState] = useState<ShortcutKeymap>(DEFAULT_SHORTCUT_KEYMAP);
    const [linkPreviewsEnabled, setLinkPreviewsEnabledState] = useState(false);

    const saveRegistry = useCallback((patch: DashboardRegistryPatch): void => {
        if (!hydratedRef.current) {
            if (import.meta.env.DEV) {
                console.warn('Ignoring dashboard preferences save before hydration');
            }
            return;
        }
        void client.patch(patch).catch((error: unknown) => {
            console.error('Failed to save dashboard preferences', error);
        });
    }, [client]);

    useEffect(() => {
        let cancelled = false;
        void client.load()
            .then(({ registry }) => {
                if (cancelled) return;
                const ui = registry.ui;
                setModeState(normalizeTheme(ui.uiTheme));
                setLocaleState(ui.locale ?? 'ko');
                setShortcutsEnabledState(ui.dashboardShortcutsEnabled);
                setKeymapState(normalizeKeymap(ui.dashboardShortcutKeymap));
                setLinkPreviewsEnabledState(ui.chatLinkPreviewsEnabled === true);
            })
            .catch((error: unknown) => {
                if (!cancelled) console.error('Failed to hydrate dashboard preferences', error);
            })
            .finally(() => {
                if (cancelled) return;
                hydratedRef.current = true;
                setHydrated(true);
            });
        return () => {
            cancelled = true;
        };
    }, [client]);

    useEffect(() => {
        const media = matchMedia('(prefers-color-scheme: dark)');
        const applyTheme = () => {
            const resolvedNow = mode === 'auto' ? systemTheme(media) : mode;
            document.documentElement.setAttribute('data-theme', mode);
            // Keep CSS color-scheme in sync so base.css light-dark() tokens
            // follow the user toggle, not only the OS preference (033 F2).
            document.documentElement.style.colorScheme = resolvedNow;
            setResolved(resolvedNow);
            try {
                localStorage.setItem('jaw.uiTheme', mode);
            } catch {
                // Theme still applies when storage is unavailable.
            }
        };
        applyTheme();
        if (mode !== 'auto') return undefined;
        media.addEventListener('change', applyTheme);
        return () => media.removeEventListener('change', applyTheme);
    }, [mode]);

    useEffect(() => {
        if (!hydrated) return;
        document.documentElement.lang = locale;
    }, [hydrated, locale]);

    const setMode = useCallback((next: DashboardUiTheme) => {
        setModeState(next);
        saveRegistry({ ui: { uiTheme: next } });
    }, [saveRegistry]);

    const setLocale = useCallback((next: DashboardLocale) => {
        setLocaleState(next);
        saveRegistry({ ui: { locale: next } });
    }, [saveRegistry]);

    const setShortcutsEnabled = useCallback((enabled: boolean) => {
        setShortcutsEnabledState(enabled);
        saveRegistry({ ui: { dashboardShortcutsEnabled: enabled } });
    }, [saveRegistry]);

    const setKeymap = useCallback((next: ShortcutKeymap) => {
        const normalized = normalizeKeymap(next);
        setKeymapState(normalized);
        saveRegistry({ ui: { dashboardShortcutKeymap: normalized } });
    }, [saveRegistry]);
    const setLinkPreviewsEnabled = useCallback((enabled: boolean) => {
        setLinkPreviewsEnabledState(enabled);
        saveRegistry({ ui: { chatLinkPreviewsEnabled: enabled } });
    }, [saveRegistry]);

    const value = useMemo<ManagerPreferences>(() => ({
        hydrated,
        theme: { mode, resolved, setMode },
        locale: { locale, setLocale },
        shortcuts: { shortcutsEnabled, keymap, setShortcutsEnabled, setKeymap },
        linkPreviews: { enabled: linkPreviewsEnabled, setEnabled: setLinkPreviewsEnabled },
    }), [
        hydrated,
        keymap,
        locale,
        linkPreviewsEnabled,
        mode,
        resolved,
        setKeymap,
        setLocale,
        setLinkPreviewsEnabled,
        setMode,
        setShortcutsEnabled,
        shortcutsEnabled,
    ]);

    return (
        <PreferencesContext.Provider value={value}>
            {props.children}
        </PreferencesContext.Provider>
    );
}

export function usePreferences(): ManagerPreferences {
    const preferences = useContext(PreferencesContext);
    if (!preferences) {
        throw new Error('usePreferences must be used inside ManagerPreferencesProvider');
    }
    return preferences;
}

export function useOptionalPreferences(): ManagerPreferences | null {
    return useContext(PreferencesContext);
}
