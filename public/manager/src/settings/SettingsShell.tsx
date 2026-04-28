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

const PAGE_REGISTRY: Record<
    SettingsCategoryId,
    LazyExoticComponent<ComponentType<SettingsPageProps>> | undefined
> = {
    'identity-preview': lazy(() => import('./pages/IdentityPreview')),
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
    prompts: undefined,
    mcp: undefined,
    browser: undefined,
    'dashboard-meta': undefined,
};

type Props = { port: number; instanceUrl: string };

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

export function SettingsShell({ port, instanceUrl }: Props) {
    const [activeId, setActiveId] = useState<SettingsCategoryId>('identity-preview');
    const dirty = useDirtyStore();
    const isDirty = useDirtyFlag(dirty);
    const client = useMemo(() => createSettingsClient(port), [port]);

    const saveHandlerRef = useRef<SaveHandler | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const registerSave = useCallback((handler: SaveHandler | null) => {
        saveHandlerRef.current = handler;
    }, []);

    // Phase 2: switching instances mid-edit must not carry dirty state across.
    // The dirty store is owned by the shell (useRef) so without this effect
    // pending edits from instance A would silently surface on instance B.
    useEffect(() => {
        dirty.clear();
        saveHandlerRef.current = null;
        setSaveError(null);
    }, [port, dirty]);

    const onSelect = useCallback(
        (next: SettingsCategoryId) => {
            if (next === activeId) return;
            if (saving) return;
            if (dirty.isDirty() && !window.confirm('Discard unsaved changes?')) return;
            dirty.clear();
            setSaveError(null);
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
            // No page-level handler registered (e.g. Phase 1 placeholder).
            dirty.clear();
            return;
        }
        setSaving(true);
        try {
            await handler();
        } catch (err: unknown) {
            setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }, [dirty, saving]);

    const Page = PAGE_REGISTRY[activeId];

    return (
        <div className="settings-shell">
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
                {(isDirty || saving || saveError) && (
                    <div
                        className="settings-action-row"
                        role="group"
                        aria-label="Unsaved changes"
                    >
                        {saveError ? (
                            <span className="settings-action-error" role="alert">
                                {saveError}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            className="settings-action settings-action-discard"
                            onClick={onDiscard}
                            disabled={saving || !isDirty}
                        >
                            Discard
                        </button>
                        <button
                            type="button"
                            className="settings-action settings-action-save"
                            onClick={onSave}
                            disabled={saving || !isDirty}
                        >
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                )}
            </section>
        </div>
    );
}
