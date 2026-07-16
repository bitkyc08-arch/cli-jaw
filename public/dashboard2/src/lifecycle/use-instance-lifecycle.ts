import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
    DashboardInstance,
    DashboardLifecycleAction,
} from '../../../../src/manager/types.ts';
import {
    ManagerApiError,
    useManagerApi,
} from '../providers/api-provider.tsx';
import { useManagerSync } from '../providers/sync-provider.tsx';
import {
    createInstanceLifecycleController,
    type InstanceLifecycleSnapshot,
} from './instance-lifecycle-controller.ts';

// Server lifecycle actions may perform service detection plus multiple bounded
// 3-5 second stop/service commands. Keep this distinct from the 10 second
// post-action state-convergence budget so a valid action cannot expose Retry
// while the manager still owns the original request.
export const INSTANCE_LIFECYCLE_ACTION_DEADLINE_MS = 30_000;

export type InstanceLifecycleUiPhase = 'idle' | 'requesting' | 'polling' | 'error';

export interface InstanceLifecycleUiState {
    phase: InstanceLifecycleUiPhase;
    port: number | null;
    action: DashboardLifecycleAction | null;
    message: string | null;
}

export interface UseInstanceLifecycleOptions {
    patchInstance(instance: DashboardInstance): void;
    refreshInstances(): Promise<void>;
}

const IDLE_UI_STATE: InstanceLifecycleUiState = {
    phase: 'idle',
    port: null,
    action: null,
    message: null,
};

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function useInstanceLifecycle(options: UseInstanceLifecycleOptions) {
    const api = useManagerApi();
    const sync = useManagerSync();
    const apiRef = useRef(api.manager);
    const optionsRef = useRef(options);
    const mountedRef = useRef(true);
    const busyRef = useRef(false);
    const runGenerationRef = useRef(0);
    const actionAbortRef = useRef<AbortController | null>(null);
    const [ui, setUi] = useState<InstanceLifecycleUiState>(IDLE_UI_STATE);
    apiRef.current = api.manager;
    optionsRef.current = options;

    const controllerRef = useRef<ReturnType<typeof createInstanceLifecycleController> | null>(null);
    if (!controllerRef.current) {
        controllerRef.current = createInstanceLifecycleController({
            fetchInstance: async (port, request) => (
                await apiRef.current.fetchInstance(port, request)
            ).instance,
            shouldRetryError: error => !(error instanceof ManagerApiError) || error.retryable,
            onSnapshot: snapshot => {
                if (snapshot.instance) optionsRef.current.patchInstance(snapshot.instance);
            },
        });
    }
    const controller = controllerRef.current;
    const convergence = useSyncExternalStore(
        controller.subscribe,
        controller.getSnapshot,
        controller.getSnapshot,
    );

    useEffect(() => {
        mountedRef.current = true;
        const unsubscribe = sync.subscribeManagerWorker(payload => {
            if (payload.event !== 'instance-status-changed') return;
            const snapshot = controller.getSnapshot();
            if (snapshot.phase === 'polling' && snapshot.port === payload.port) controller.wake();
        });
        return () => {
            mountedRef.current = false;
            runGenerationRef.current += 1;
            busyRef.current = false;
            actionAbortRef.current?.abort();
            actionAbortRef.current = null;
            unsubscribe();
            controller.abort();
        };
    }, [controller, sync]);

    const run = useCallback(async (
        action: DashboardLifecycleAction,
        instance: DashboardInstance,
    ): Promise<boolean> => {
        if (busyRef.current) return false;
        busyRef.current = true;
        const generation = ++runGenerationRef.current;
        const actionAbort = new AbortController();
        actionAbortRef.current = actionAbort;
        let actionTimedOut = false;
        const actionDeadline = globalThis.setTimeout(() => {
            actionTimedOut = true;
            actionAbort.abort();
        }, INSTANCE_LIFECYCLE_ACTION_DEADLINE_MS);
        const isCurrent = (): boolean => mountedRef.current
            && runGenerationRef.current === generation
            && !actionAbort.signal.aborted;
        setUi({ phase: 'requesting', port: instance.port, action, message: null });
        try {
            const result = await apiRef.current.runLifecycleAction(
                action,
                instance.port,
                undefined,
                { signal: actionAbort.signal },
            );
            globalThis.clearTimeout(actionDeadline);
            if (!isCurrent()) return false;
            actionAbortRef.current = null;
            if (action !== 'start' && action !== 'stop') {
                await optionsRef.current.refreshInstances();
                if (!isCurrent()) return false;
                setUi(IDLE_UI_STATE);
                return true;
            }

            const expectedState = action === 'start' ? 'online' : 'offline';
            if (result.ok !== true || result.expectedStateAfter !== expectedState) {
                throw new Error(result.message || `${action} did not declare ${expectedState}`);
            }
            if (mountedRef.current) {
                setUi({
                    phase: 'polling',
                    port: instance.port,
                    action,
                    message: action === 'start' ? 'Starting…' : 'Stopping…',
                });
            }
            const settled = await controller.start({ port: instance.port, expectedState });
            if (!isCurrent() || settled.phase === 'aborted') return false;
            if (settled.phase !== expectedState) {
                const detail = settled.lastError ? `: ${settled.lastError}` : '';
                throw new Error(
                    settled.phase === 'timed-out'
                        ? `${action} timed out after ${settled.attempts} checks${detail}`
                        : settled.lastError || `${action} convergence failed`,
                );
            }
            setUi(IDLE_UI_STATE);
            return true;
        } catch (error) {
            if (mountedRef.current && runGenerationRef.current === generation) {
                setUi({
                    phase: 'error',
                    port: instance.port,
                    action,
                    message: actionTimedOut
                        ? `${action} request timed out`
                        : message(error),
                });
            }
            return false;
        } finally {
            globalThis.clearTimeout(actionDeadline);
            if (actionAbortRef.current === actionAbort) actionAbortRef.current = null;
            if (runGenerationRef.current === generation) busyRef.current = false;
        }
    }, [controller]);

    const clearError = useCallback(() => {
        if (ui.phase === 'error') setUi(IDLE_UI_STATE);
    }, [ui.phase]);

    return {
        ui,
        convergence: convergence as InstanceLifecycleSnapshot,
        busy: ui.phase === 'requesting' || ui.phase === 'polling',
        busyPort: ui.port,
        run,
        clearError,
    };
}
