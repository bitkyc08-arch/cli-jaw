import {
    Suspense,
    lazy,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import type {
    SettingsCategoryId,
    SettingsPageProps,
    DirtyStore,
    SaveHandler,
} from './types';
import { SettingsSidebar } from './SettingsSidebar';
import { createDirtyStore } from './dirty-store';
import { createSettingsClient } from './settings-client';
import { SaveBar } from './components/SaveBar';
import { Toast, type ToastShape } from './components/Toast';
import { useSaveShortcut } from './components/useSaveShortcut';
import { describeError } from './components/error-normalize';

const PAGE_REGISTRY: Record<
    SettingsCategoryId,
    LazyExoticComponent<ComponentType<SettingsPageProps>>
> = {
    agent: lazy(() => import('./pages/Agent')),
    profile: lazy(() => import('./pages/Profile')),
    display: lazy(() => import('./pages/Display')),
    model: lazy(() => import('./pages/ModelProvider')),
    'channels-telegram': lazy(() => import('./pages/ChannelsTelegram')),
    'channels-discord': lazy(() => import('./pages/ChannelsDiscord')),
    speech: lazy(() => import('./pages/SpeechKeys')),
    heartbeat: lazy(() => import('./pages/Heartbeat')),
    memory: lazy(() => import('./pages/Memory')),
    employees: lazy(() => import('./pages/Employees')),
    network: lazy(() => import('./pages/Network')),
    permissions: lazy(() => import('./pages/Permissions')),
    prompts: lazy(() => import('./pages/Prompts')),
    mcp: lazy(() => import('./pages/Mcp')),
    browser: lazy(() => import('./pages/Browser')),
    'dashboard-meta': lazy(() => import('./pages/DashboardMeta')),
    'advanced-export': lazy(() => import('./pages/AdvancedExport')),
};

type Props = {
    port: number;
    instanceUrl: string;
    onDirtyChange?: (dirty: boolean) => void;
    onSaved?: () => void;
};

function useDirtyStore(): DirtyStore {
    const ref = useRef<DirtyStore | null>(null);
    if (ref.current === null) ref.current = createDirtyStore();
    return ref.current;
}

function useDirtyFlag(store: DirtyStore): boolean {
    return useSyncExternalStore(
        useCallback((listener) => store.subscribe(listener), [store]),
        useCallback(() => store.isDirty(), [store]),
        useCallback(() => false, []),
    );
}

function usePendingCount(store: DirtyStore): number {
    return useSyncExternalStore(
        useCallback((listener) => store.subscribe(listener), [store]),
        useCallback(() => store.pending.size, [store]),
        useCallback(() => 0, []),
    );
}

export function SettingsShell({ port, instanceUrl, onDirtyChange, onSaved }: Props) {
    const [activeId, setActiveId] = useState<SettingsCategoryId>('agent');
    const dirty = useDirtyStore();
    const isDirty = useDirtyFlag(dirty);
    const pendingCount = usePendingCount(dirty);
    const client = useMemo(() => createSettingsClient(port), [port]);

    const saveHandlerRef = useRef<SaveHandler | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [toast, setToast] = useState<ToastShape | null>(null);

    const containerRef = useRef<HTMLDivElement | null>(null);

    const registerSave = useCallback((handler: SaveHandler | null) => {
        saveHandlerRef.current = handler;
    }, []);

    // Phase 2: switching instances mid-edit must not carry dirty state across.
    useEffect(() => {
        dirty.clear();
        saveHandlerRef.current = null;
        setSaveError(null);
        setToast(null);
    }, [port, dirty]);

    useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    useEffect(() => {
        return () => onDirtyChange?.(false);
    }, [onDirtyChange]);

    const onSelect = useCallback(
        (next: SettingsCategoryId) => {
            if (next === activeId) return;
            if (saving) return;
            if (dirty.isDirty() && !window.confirm('Discard unsaved changes?')) return;
            dirty.clear();
            setSaveError(null);
            setToast(null);
            saveHandlerRef.current = null;
            setActiveId(next);
        },
        [activeId, dirty, saving],
    );

    const onDiscard = useCallback(() => {
        if (saving) return;
        dirty.clear();
        setSaveError(null);
    }, [dirty, saving]);

    const onSave = useCallback(async () => {
        if (saving) return;
        const handler = saveHandlerRef.current;
        setSaveError(null);
        if (!handler) {
            dirty.clear();
            return;
        }
        setSaving(true);
        try {
            await handler();
            onSaved?.();
            setToast({ kind: 'ok', message: 'Saved.' });
        } catch (err: unknown) {
            const message = describeError(err);
            setSaveError(message);
            setToast({ kind: 'err', message: `Failed: ${message}` });
        } finally {
            setSaving(false);
        }
    }, [dirty, onSaved, saving]);

    useSaveShortcut({
        enabled: isDirty && !saving,
        containerRef,
        onSave: () => {
            void onSave();
        },
    });

    const Page = PAGE_REGISTRY[activeId];

    return (
        <div className="settings-shell" ref={containerRef}>
            <SettingsSidebar activeId={activeId} onSelect={onSelect} />
            <section className="settings-page" aria-live="polite">
                <Suspense fallback={<div className="settings-loading">Loading…</div>}>
                    {Page ? (
                        <Page
                            port={port}
                            instanceUrl={instanceUrl}
                            client={client}
                            dirty={dirty}
                            registerSave={registerSave}
                        />
                    ) : (
                        <div className="settings-placeholder">
                            This page lands in a later phase.
                        </div>
                    )}
                </Suspense>
                <SaveBar
                    isDirty={isDirty}
                    saving={saving}
                    pendingCount={pendingCount}
                    error={saveError}
                    onDiscard={onDiscard}
                    onSave={() => void onSave()}
                />
                {toast ? (
                    <Toast
                        kind={toast.kind}
                        message={toast.message}
                        onDismiss={() => setToast(null)}
                    />
                ) : null}
            </section>
        </div>
    );
}
