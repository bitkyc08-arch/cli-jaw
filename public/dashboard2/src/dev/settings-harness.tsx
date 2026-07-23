import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../styles/workbench-v4.css';
import '../styles/turn-stream.css';
import '../styles/render-content.css';
import '../models/model-picker.css';
import '../features/hover-dock/hover-dock.css';
import '../features/settings/settings.css';
import { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DashboardRegistry } from '../../../../src/manager/types.ts';
import { SettingsWorkspace } from '../features/settings/SettingsWorkspace.tsx';
import { ManagerApiProvider } from '../providers/api-provider.tsx';
import { DesktopBridgeProvider } from '../providers/desktop-bridge-provider.tsx';
import { ManagerShortcutProvider } from '../providers/shortcut-provider.tsx';
import { ManagerSyncProvider } from '../providers/sync-provider.tsx';
import { ManagerPreferencesProvider, type PreferencesRegistryClient } from '../providers/preferences-provider.tsx';
import { AppScopeProvider, useAppScope } from '../state/scope.tsx';
import { Workbench } from '../shell/Workbench.tsx';

let root: Root | null = null;

function SelectedSettings() {
    const scope = useAppScope();
    useEffect(() => {
        void scope.guardedSelectSession(3506, 'wp4-settings-session')
            .then(() => scope.guardedSetWorkspaceMode('settings'));
    }, []);
    return <div data-settings-harness-frame style={{ width: '100%', height: '100%', minWidth: 0, containerType: 'inline-size' }}><SettingsWorkspace /></div>;
}

function SelectedWorkbench() {
    const scope = useAppScope();
    useEffect(() => { void scope.guardedSelectSession(3506, 'wp4-settings-session'); }, []);
    return <div style={{ display: 'grid', width: '100%', height: '100dvh', minWidth: 0, minHeight: 0, overflow: 'hidden' }}><Workbench /></div>;
}

const registry = {
    ui: {
        uiTheme: 'dark',
        locale: 'en',
        dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: {},
        chatLinkPreviewsEnabled: false,
    },
} as unknown as DashboardRegistry;

const preferencesClient: PreferencesRegistryClient = {
    load: async () => ({ registry, status: {} as never }),
    patch: async () => ({ registry, status: {} as never }),
};

function Harness() {
    return (
        <ManagerPreferencesProvider>
            <AppScopeProvider>
                <ManagerSyncProvider>
                    <SelectedSettings />
                </ManagerSyncProvider>
            </AppScopeProvider>
        </ManagerPreferencesProvider>
    );
}

export function mountSettingsHarness(target: HTMLElement): void {
    root?.unmount();
    root = createRoot(target);
    root.render(<Harness />);
}

interface ResourceSnapshot { listeners: number; timers: number }

declare global {
    interface Window {
        __settingsResourceProbe: { snapshot(): ResourceSnapshot };
    }
}

function installResourceProbe(): void {
    const listenerSets = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
    for (const target of [window, document]) {
        const byType = new Map<string, Set<EventListenerOrEventListenerObject>>();
        listenerSets.set(target, byType);
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
            if (listener) {
                const listeners = byType.get(type) ?? new Set<EventListenerOrEventListenerObject>();
                listeners.add(listener);
                byType.set(type, listeners);
            }
            if (listener) add(type, listener, options);
        }) as typeof target.addEventListener;
        target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
            if (listener) byType.get(type)?.delete(listener);
            if (listener) remove(type, listener, options);
        }) as typeof target.removeEventListener;
    }

    const timeouts = new Set<number>();
    const intervals = new Set<number>();
    const setTimeoutNative = window.setTimeout.bind(window);
    const clearTimeoutNative = window.clearTimeout.bind(window);
    const setIntervalNative = window.setInterval.bind(window);
    const clearIntervalNative = window.clearInterval.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        let id = 0;
        id = setTimeoutNative(() => {
            timeouts.delete(id);
            if (typeof handler === 'function') handler(...args);
        }, timeout);
        timeouts.add(id);
        return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
        if (id !== undefined) timeouts.delete(id);
        clearTimeoutNative(id);
    }) as typeof window.clearTimeout;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const id = setIntervalNative(handler, timeout, ...args);
        intervals.add(id);
        return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
        if (id !== undefined) intervals.delete(id);
        clearIntervalNative(id);
    }) as typeof window.clearInterval;
    window.__settingsResourceProbe = {
        snapshot: () => ({
            listeners: [...listenerSets.values()].reduce((sum, byType) => (
                sum + [...byType.values()].reduce((count, listeners) => count + listeners.size, 0)
            ), 0),
            timers: timeouts.size + intervals.size,
        }),
    };
}

export function mountSettingsWorkbenchHarness(target: HTMLElement): void {
    root?.unmount();
    installResourceProbe();
    root = createRoot(target);
    root.render(
        <ManagerApiProvider>
            <ManagerPreferencesProvider client={preferencesClient}>
                <DesktopBridgeProvider>
                    <ManagerShortcutProvider>
                        <AppScopeProvider>
                            <ManagerSyncProvider>
                                <SelectedWorkbench />
                            </ManagerSyncProvider>
                        </AppScopeProvider>
                    </ManagerShortcutProvider>
                </DesktopBridgeProvider>
            </ManagerPreferencesProvider>
        </ManagerApiProvider>,
    );
}

export function unmountSettingsHarness(): void {
    root?.unmount();
    root = null;
}
