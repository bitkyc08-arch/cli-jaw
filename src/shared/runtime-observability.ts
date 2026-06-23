export type RuntimeSurface = 'worker_run' | 'background_task';
export type RuntimeStatusCategory = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'orphaned';

export const WORKER_RUN_STATUS_CATEGORY = {
    running: 'running',
    done: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
} as const satisfies Record<string, RuntimeStatusCategory>;

export const BGTASK_STATUS_CATEGORY = {
    running: 'running',
    complete: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    orphaned: 'orphaned',
} as const satisfies Record<string, RuntimeStatusCategory>;

export type WorkerRunObservableStatus = keyof typeof WORKER_RUN_STATUS_CATEGORY;
export type BgTaskObservableStatus = keyof typeof BGTASK_STATUS_CATEGORY;

export interface RuntimeSafeSummary {
    surface: RuntimeSurface;
    id: string;
    nativeStatus: string;
    statusCategory: RuntimeStatusCategory;
    label?: string;
    preview?: string;
    recoveryCommand?: string;
    outputBytes?: number;
    updatedAt?: string | number | null;
}

export function normalizeWorkerRunStatus(status: WorkerRunObservableStatus): RuntimeStatusCategory {
    return WORKER_RUN_STATUS_CATEGORY[status];
}

export function normalizeBgTaskStatus(status: BgTaskObservableStatus): RuntimeStatusCategory {
    return BGTASK_STATUS_CATEGORY[status];
}
