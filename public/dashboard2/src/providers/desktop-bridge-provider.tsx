import {
    createContext,
    useContext,
    useMemo,
    type JSX,
    type PropsWithChildren,
} from 'react';
import type {
    BrowserBridgeApi,
    ClipboardBridgeApi,
    DesktopPreloadApi,
    DiffBridgeApi,
    DragDropBridgeApi,
    FolderBridgeApi,
    GitBridgeApi,
    ShortcutsBridgeApi,
    TerminalBridgeApi,
    TrayBridgeApi,
} from './desktop-bridge-contract.ts';

export interface CapabilitySurface<NativeApi, FallbackApi = never> {
    nativeAvailable: boolean;
    nativeWired: boolean;
    native: NativeApi | null;
    fallback: {
        available: boolean;
        transport: 'http' | 'web-api' | 'stub' | 'none';
        adapter: FallbackApi | null;
    };
}

export interface DesktopEnvironment {
    isElectron: boolean;
    detection: 'bridge-identity' | 'document-marker' | 'user-agent' | 'web';
    identity: {
        name: string;
        electron: boolean;
        header: string;
    } | null;
}

interface EnvelopeAdapter {
    identify(): DesktopEnvironment['identity'];
    getHomePath(): string;
}

interface ClipboardAdapter {
    writeText(text: string): Promise<void>;
}

interface ReloadAdapter {
    reloadWindow(): Promise<void>;
    hardReloadWindow(): Promise<void>;
}

type ExposedBrowserApi = Pick<
    BrowserBridgeApi,
    | 'onOpenUrl'
    | 'registerWebview'
    | 'unregisterWebview'
    | 'performWebviewAction'
    | 'getWebviewTabs'
    | 'onWebviewState'
    | 'onElementPicked'
>;

export interface DesktopBridgeContextValue {
    environment: DesktopEnvironment;
    getAuthHeader(): { name: string; value: string } | null;
    envelope: CapabilitySurface<EnvelopeAdapter>;
    filesystem: {
        folder: CapabilitySurface<FolderBridgeApi>;
        dragDrop: CapabilitySurface<DragDropBridgeApi>;
        clipboard: CapabilitySurface<ClipboardAdapter, ClipboardAdapter>;
    };
    terminal: CapabilitySurface<TerminalBridgeApi>;
    sourceControl: {
        diff: CapabilitySurface<DiffBridgeApi>;
        git: CapabilitySurface<GitBridgeApi>;
    };
    browser: CapabilitySurface<ExposedBrowserApi>;
    shell: {
        shortcuts: CapabilitySurface<ShortcutsBridgeApi>;
        reload: CapabilitySurface<ReloadAdapter, ReloadAdapter>;
        tray: CapabilitySurface<TrayBridgeApi>;
    };
}

const DesktopBridgeContext = createContext<DesktopBridgeContextValue | null>(null);

function hasFunctions(value: unknown, names: string[]): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return names.every((name) => typeof record[name] === 'function');
}

function unavailable<NativeApi>(transport: 'stub' | 'none' = 'none'): CapabilitySurface<NativeApi> {
    return {
        nativeAvailable: false,
        nativeWired: false,
        native: null,
        fallback: { available: false, transport, adapter: null },
    };
}

function detectDesktop(raw: DesktopPreloadApi | null): {
    environment: DesktopEnvironment;
    token: string | null;
} {
    try {
        const identified = raw?.identify?.();
        if (identified?.electron === true) {
            return {
                environment: {
                    isElectron: true,
                    detection: 'bridge-identity',
                    identity: {
                        name: identified.name,
                        electron: identified.electron,
                        header: identified.header,
                    },
                },
                token: identified.token || null,
            };
        }
    } catch {
        // Old or partially initialized preloads fall through to compatibility signals.
    }

    if (
        typeof document !== 'undefined'
        && document.documentElement.dataset['cliJawDesktop'] === 'true'
    ) {
        return {
            environment: { isElectron: true, detection: 'document-marker', identity: null },
            token: null,
        };
    }
    if (
        typeof navigator !== 'undefined'
        && /\bcli-jaw-desktop(?:\/|\b)/.test(navigator.userAgent)
    ) {
        return {
            environment: { isElectron: true, detection: 'user-agent', identity: null },
            token: null,
        };
    }
    return {
        environment: { isElectron: false, detection: 'web', identity: null },
        token: null,
    };
}

function createDesktopBridgeValue(): DesktopBridgeContextValue {
    const raw = typeof window === 'undefined'
        ? null
        : (window as unknown as { cliJawDesktop?: DesktopPreloadApi }).cliJawDesktop ?? null;
    const detected = detectDesktop(raw);
    const authHeader = detected.environment.identity && detected.token
        ? { name: detected.environment.identity.header, value: detected.token }
        : null;

    const envelopeAvailable = hasFunctions(raw, ['identify', 'getHomePath']);
    const envelopeNative: EnvelopeAdapter | null = envelopeAvailable && raw?.identify && raw.getHomePath
        ? {
            identify: () => detected.environment.identity,
            getHomePath: () => raw.getHomePath!(),
        }
        : null;

    const nativeClipboardAvailable = hasFunctions(raw?.clipboard, ['writeText']);
    const nativeClipboard: ClipboardAdapter | null = nativeClipboardAvailable && raw?.clipboard
        ? {
            async writeText(text) {
                const result = await raw.clipboard!.writeText(text);
                if (!result.ok) throw new Error(result.error ?? 'Native clipboard write failed');
            },
        }
        : null;
    const webClipboardAvailable = typeof navigator !== 'undefined'
        && typeof navigator.clipboard?.writeText === 'function';
    const webClipboard: ClipboardAdapter | null = webClipboardAvailable
        ? { writeText: (text) => navigator.clipboard.writeText(text) }
        : null;

    const nativeReloadAvailable = hasFunctions(raw, ['reloadWindow', 'hardReloadWindow']);
    const nativeReload: ReloadAdapter | null = nativeReloadAvailable && raw?.reloadWindow && raw.hardReloadWindow
        ? {
            reloadWindow: () => raw.reloadWindow!(),
            hardReloadWindow: () => raw.hardReloadWindow!(),
        }
        : null;
    const webReloadAvailable = typeof window !== 'undefined' && typeof window.location?.reload === 'function';
    const webReload: ReloadAdapter | null = webReloadAvailable
        ? {
            async reloadWindow() { window.location.reload(); },
            async hardReloadWindow() { window.location.reload(); },
        }
        : null;

    const terminalAvailable = hasFunctions(
        raw?.terminal,
        ['list', 'create', 'write', 'resize', 'kill', 'onData', 'onExit'],
    );
    const folderAvailable = hasFunctions(
        raw?.folder,
        [
            'getDefaultRoot', 'pickFolder', 'pickFile', 'authorizeRoot',
            'registerGitWorktreeRoot', 'listDir', 'readFile', 'movePath',
            'createFile', 'createFolder', 'renamePath', 'revealPath',
            'watchDir', 'unwatchDir', 'onDirChange',
        ],
    );
    const dragDropAvailable = hasFunctions(raw?.dragDrop, ['resolveDroppedItems']);
    const diffAvailable = hasFunctions(
        raw?.diff,
        ['getRepoRoot', 'getRepoCandidates', 'getScmSnapshot', 'runScmOperation', 'getDiffSummary', 'getFileDiff'],
    );
    const gitAvailable = hasFunctions(
        raw?.git,
        ['getStatusMap', 'getWorktrees', 'previewWorktreeOperation', 'runWorktreeOperation'],
    );
    const browserAvailable = hasFunctions(
        raw?.browser,
        [
            'onOpenUrl', 'registerWebview', 'unregisterWebview', 'performWebviewAction',
            'getWebviewTabs', 'onWebviewState', 'onElementPicked',
        ],
    );
    const shortcutsAvailable = hasFunctions(raw?.shortcuts, ['onAction']);
    const trayAvailable = hasFunctions(raw?.trayReminders, ['popUpMenu', 'openDashboard']);

    return {
        environment: detected.environment,
        getAuthHeader: () => authHeader ? { ...authHeader } : null,
        envelope: {
            nativeAvailable: envelopeAvailable,
            nativeWired: true,
            native: envelopeNative,
            fallback: { available: false, transport: 'none', adapter: null },
        },
        filesystem: {
            folder: { ...unavailable<FolderBridgeApi>(), nativeAvailable: folderAvailable },
            dragDrop: { ...unavailable<DragDropBridgeApi>(), nativeAvailable: dragDropAvailable },
            clipboard: {
                nativeAvailable: nativeClipboardAvailable,
                nativeWired: true,
                native: nativeClipboard,
                fallback: {
                    available: webClipboardAvailable,
                    transport: 'web-api',
                    adapter: webClipboard,
                },
            },
        },
        terminal: { ...unavailable<TerminalBridgeApi>(), nativeAvailable: terminalAvailable },
        sourceControl: {
            // HTTP adapters are injected here when dashboard2 source-control migration lands.
            diff: { ...unavailable<DiffBridgeApi>('stub'), nativeAvailable: diffAvailable },
            git: { ...unavailable<GitBridgeApi>('stub'), nativeAvailable: gitAvailable },
        },
        browser: { ...unavailable<ExposedBrowserApi>(), nativeAvailable: browserAvailable },
        shell: {
            shortcuts: { ...unavailable<ShortcutsBridgeApi>(), nativeAvailable: shortcutsAvailable },
            reload: {
                nativeAvailable: nativeReloadAvailable,
                nativeWired: true,
                native: nativeReload,
                fallback: {
                    available: webReloadAvailable,
                    transport: 'web-api',
                    adapter: webReload,
                },
            },
            tray: { ...unavailable<TrayBridgeApi>(), nativeAvailable: trayAvailable },
        },
    };
}

export function DesktopBridgeProvider(props: PropsWithChildren): JSX.Element {
    const value = useMemo(createDesktopBridgeValue, []);
    return (
        <DesktopBridgeContext.Provider value={value}>
            {props.children}
        </DesktopBridgeContext.Provider>
    );
}

export function useDesktopBridge(): DesktopBridgeContextValue {
    const value = useContext(DesktopBridgeContext);
    if (!value) {
        throw new Error('useDesktopBridge must be used inside DesktopBridgeProvider');
    }
    return value;
}
