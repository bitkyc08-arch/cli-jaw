import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { SettingsRecord } from '../features/settings/settings-types.ts';
import {
    fetchCliRegistry,
    fetchInstanceSettings,
    saveInstanceSettings,
    SettingsRequestError,
    type SettingsRequestErrorCode,
} from '../features/settings/settings-api.ts';
import {
    adaptModelSettings,
    adaptSavedModelSettings,
    buildModelSettingsPatch,
    revalidateModelSelection,
    type AdaptedModelSettings,
    type ModelCatalog,
    type ModelMutationMode,
    type ModelSelection,
} from './model-settings-adapter.ts';
import { useManagerSync } from '../providers/sync-provider.tsx';

export type InstanceModelSettingsStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'saving'
    | 'empty'
    | 'error';

export type InstanceModelSettingsErrorCode =
    | 'load_failed'
    | 'save_failed'
    | 'inventory_unavailable';

export interface InstanceModelSettingsError {
    code: InstanceModelSettingsErrorCode;
    requestCode?: SettingsRequestErrorCode;
    message: string;
}

export interface InstanceModelSettingsSnapshot {
    port: number | null;
    generation: number;
    status: InstanceModelSettingsStatus;
    mode: ModelMutationMode;
    selection: ModelSelection | null;
    defaultSelection: ModelSelection | null;
    catalog: ModelCatalog | null;
    activeOverrideMasksDefault: boolean;
    error: InstanceModelSettingsError | null;
}

export interface InstanceModelSettingsActions {
    save(selection: ModelSelection): Promise<boolean>;
    reload(): void;
}

export interface UseInstanceModelSettingsResult {
    snapshot: InstanceModelSettingsSnapshot;
    actions: InstanceModelSettingsActions;
}

export interface InstanceModelSettingsClient {
    fetchSettings(port: number, options: { signal: AbortSignal }): Promise<SettingsRecord>;
    fetchRegistry(port: number, options: { signal: AbortSignal }): Promise<SettingsRecord>;
    saveSettings(
        port: number,
        patch: SettingsRecord,
        options: { signal: AbortSignal },
    ): Promise<SettingsRecord>;
}

export interface UseInstanceModelSettingsOptions {
    port: number | null;
    mode?: ModelMutationMode;
    client?: InstanceModelSettingsClient;
}

const defaultClient: InstanceModelSettingsClient = {
    fetchSettings: (port, options) => fetchInstanceSettings(port, options),
    fetchRegistry: (port, options) => fetchCliRegistry(port, options),
    saveSettings: (port, patch, options) => saveInstanceSettings(port, patch, options),
};

function initialSnapshot(mode: ModelMutationMode): InstanceModelSettingsSnapshot {
    return {
        port: null,
        generation: 0,
        status: 'idle',
        mode,
        selection: null,
        defaultSelection: null,
        catalog: null,
        activeOverrideMasksDefault: false,
        error: null,
    };
}

function statusFor(adapted: AdaptedModelSettings): 'ready' | 'empty' {
    return adapted.catalog.mutationEnabled ? 'ready' : 'empty';
}

function safeError(
    code: InstanceModelSettingsErrorCode,
    error?: unknown,
): InstanceModelSettingsError {
    const requestCode = error instanceof SettingsRequestError ? error.code : undefined;
    const message = code === 'inventory_unavailable'
        ? 'Model selection is unavailable because the live model inventory is empty.'
        : code === 'save_failed'
            ? 'The model selection was not saved. The worker state was reloaded.'
            : requestCode === 'invalid_content_type'
                ? 'The settings endpoint returned a non-JSON response.'
                : 'The model settings could not be loaded.';
    return {
        code,
        ...(requestCode ? { requestCode } : {}),
        message,
    };
}

function snapshotFromAdapted(
    port: number,
    generation: number,
    mode: ModelMutationMode,
    adapted: AdaptedModelSettings,
    error: InstanceModelSettingsError | null = null,
): InstanceModelSettingsSnapshot {
    const displayedSelection = mode === 'default'
        ? adapted.defaultSelection
        : adapted.selection;
    return {
        port,
        generation,
        status: error ? 'error' : statusFor(adapted),
        mode,
        selection: displayedSelection,
        defaultSelection: adapted.defaultSelection,
        catalog: adapted.catalog,
        activeOverrideMasksDefault: adapted.activeOverrideMasksDefault,
        error,
    };
}

function selectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
    return left.cli === right.cli
        && left.provider === right.provider
        && left.model === right.model
        && left.effort === right.effort;
}

interface BusyOperation {
    generation: number;
    kind: 'load' | 'reload' | 'save';
}

export function useInstanceModelSettings(
    options: UseInstanceModelSettingsOptions,
): UseInstanceModelSettingsResult {
    const mode = options.mode ?? 'active';
    const sync = useManagerSync();
    const clientRef = useRef(options.client ?? defaultClient);
    const modeRef = useRef(mode);
    const portRef = useRef(options.port);
    const mountedRef = useRef(true);
    const generationRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const busyRef = useRef<BusyOperation | null>(null);
    const reloadQueuedRef = useRef(false);
    const reloadScheduledRef = useRef(false);
    const adaptedRef = useRef<AdaptedModelSettings | null>(null);
    const drainReloadRef = useRef<() => void>(() => {});
    const [snapshot, setSnapshot] = useState<InstanceModelSettingsSnapshot>(() => initialSnapshot(mode));
    clientRef.current = options.client ?? defaultClient;
    modeRef.current = mode;
    portRef.current = options.port;

    const isCurrent = useCallback((generation: number, port: number): boolean => (
        mountedRef.current
        && generationRef.current === generation
        && portRef.current === port
        && abortRef.current?.signal.aborted === false
    ), []);

    const finishOperation = useCallback((generation: number): void => {
        if (busyRef.current?.generation !== generation) return;
        busyRef.current = null;
        drainReloadRef.current();
    }, []);

    const load = useCallback(async (
        port: number,
        generation: number,
        kind: 'load' | 'reload',
    ): Promise<void> => {
        const controller = abortRef.current;
        if (!controller || controller.signal.aborted || busyRef.current) {
            if (kind === 'reload') reloadQueuedRef.current = true;
            return;
        }
        busyRef.current = { generation, kind };
        if (kind === 'load') {
            setSnapshot({
                ...initialSnapshot(modeRef.current),
                port,
                generation,
                status: 'loading',
            });
        }
        try {
            const [settings, registry] = await Promise.all([
                clientRef.current.fetchSettings(port, { signal: controller.signal }),
                clientRef.current.fetchRegistry(port, { signal: controller.signal }),
            ]);
            if (!isCurrent(generation, port)) return;
            const adapted = adaptModelSettings(settings, registry, modeRef.current);
            adaptedRef.current = adapted;
            setSnapshot(snapshotFromAdapted(port, generation, modeRef.current, adapted));
        } catch (error) {
            if (!isCurrent(generation, port)) return;
            adaptedRef.current = null;
            setSnapshot({
                ...initialSnapshot(modeRef.current),
                port,
                generation,
                status: 'error',
                error: safeError('load_failed', error),
            });
        } finally {
            finishOperation(generation);
        }
    }, [finishOperation, isCurrent]);

    const drainReload = useCallback((): void => {
        if (reloadScheduledRef.current) return;
        reloadScheduledRef.current = true;
        queueMicrotask(() => {
            reloadScheduledRef.current = false;
            if (!mountedRef.current || busyRef.current || !reloadQueuedRef.current) return;
            const port = portRef.current;
            const controller = abortRef.current;
            if (port === null || !controller || controller.signal.aborted) return;
            reloadQueuedRef.current = false;
            void load(port, generationRef.current, 'reload');
        });
    }, [load]);
    drainReloadRef.current = drainReload;

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            generationRef.current += 1;
            abortRef.current?.abort();
            abortRef.current = null;
            busyRef.current = null;
            adaptedRef.current = null;
            reloadQueuedRef.current = false;
        };
    }, []);

    useEffect(() => {
        const generation = ++generationRef.current;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        busyRef.current = null;
        adaptedRef.current = null;
        reloadQueuedRef.current = false;
        reloadScheduledRef.current = false;
        const port = options.port;
        if (port === null) {
            setSnapshot(initialSnapshot(modeRef.current));
            return () => controller.abort();
        }
        void load(port, generation, 'load');
        return () => {
            controller.abort();
            if (abortRef.current === controller) abortRef.current = null;
        };
    }, [load, mode, options.port]);

    useEffect(() => sync.subscribeManagerWorker(payload => {
        if (payload.event !== 'worker_settings_change' || payload.port !== portRef.current) return;
        reloadQueuedRef.current = true;
        drainReloadRef.current();
    }), [sync]);

    const reload = useCallback((): void => {
        reloadQueuedRef.current = true;
        drainReloadRef.current();
    }, []);

    const save = useCallback(async (requested: ModelSelection): Promise<boolean> => {
        const port = portRef.current;
        const generation = generationRef.current;
        const controller = abortRef.current;
        const before = adaptedRef.current;
        if (port === null || !controller || controller.signal.aborted || !before || busyRef.current) return false;
        if (!before.catalog.mutationEnabled) {
            setSnapshot(snapshotFromAdapted(
                port,
                generation,
                modeRef.current,
                before,
                safeError('inventory_unavailable'),
            ));
            return false;
        }
        const currentSelection = modeRef.current === 'default'
            ? before.defaultSelection
            : before.selection;
        const selection = revalidateModelSelection(currentSelection, requested, before.catalog);
        if (selectionsEqual(currentSelection, selection)) return true;
        busyRef.current = { generation, kind: 'save' };
        const optimistic = modeRef.current === 'default'
            ? { ...before, defaultSelection: selection }
            : { ...before, selection };
        setSnapshot({
            ...snapshotFromAdapted(port, generation, modeRef.current, optimistic),
            status: 'saving',
        });
        try {
            const saved = await clientRef.current.saveSettings(
                port,
                buildModelSettingsPatch(selection, modeRef.current, before),
                { signal: controller.signal },
            );
            if (!isCurrent(generation, port)) return false;
            const adapted = adaptSavedModelSettings(saved, before, modeRef.current);
            adaptedRef.current = adapted;
            setSnapshot(snapshotFromAdapted(port, generation, modeRef.current, adapted));
            return true;
        } catch (error) {
            if (!isCurrent(generation, port)) return false;
            reloadQueuedRef.current = false;
            let authoritative = before;
            try {
                const [settings, registry] = await Promise.all([
                    clientRef.current.fetchSettings(port, { signal: controller.signal }),
                    clientRef.current.fetchRegistry(port, { signal: controller.signal }),
                ]);
                if (!isCurrent(generation, port)) return false;
                authoritative = adaptModelSettings(settings, registry, modeRef.current);
            } catch {
                if (!isCurrent(generation, port)) return false;
            }
            adaptedRef.current = authoritative;
            setSnapshot(snapshotFromAdapted(
                port,
                generation,
                modeRef.current,
                authoritative,
                safeError('save_failed', error),
            ));
            return false;
        } finally {
            finishOperation(generation);
        }
    }, [finishOperation, isCurrent]);

    const actions = useMemo<InstanceModelSettingsActions>(() => ({ save, reload }), [reload, save]);
    return { snapshot, actions };
}
