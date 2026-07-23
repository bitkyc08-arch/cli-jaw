import { createRoot, type Root } from 'react-dom/client';
import { ScheduleView } from './ScheduleView.tsx';
import type {
    ScheduleApi,
    ScheduleDispatchStatus,
    ScheduleWorkInput,
    ScheduleWorkItem,
    ScheduleWorkPatch,
} from './schedule-api-adapter.ts';

export interface ScheduleHarnessControl {
    setActive(active: boolean): void;
    setDispatchStatus(status: ScheduleDispatchStatus): void;
    metrics(): { listCalls: number; dispatchCalls: number; claimChangedFixtureCalls: number };
    unmount(): void;
}

function fixtureItem(input: ScheduleWorkInput = { title: 'Fixture scheduled work' }): ScheduleWorkItem {
    const now = '2026-07-23T00:00:00.000Z';
    return {
        id: 'fixture-schedule-1',
        title: input.title,
        group: input.group ?? 'upcoming',
        cron: input.cron ?? null,
        runAt: input.runAt ?? null,
        targetPort: input.targetPort ?? 3506,
        payload: input.payload ?? null,
        enabled: input.enabled ?? true,
        lastRunAt: null,
        lastStatus: null,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
    };
}

export function mountScheduleFixtureHarness(target: HTMLElement): ScheduleHarnessControl {
    let root: Root | null = createRoot(target);
    let active = false;
    let items = [fixtureItem()];
    let dispatchStatus: ScheduleDispatchStatus = 'queued';
    let listCalls = 0;
    let dispatchCalls = 0;
    let claimChangedFixtureCalls = 0;

    const api: ScheduleApi = {
        async list() {
            listCalls += 1;
            return items.map((item) => ({ ...item }));
        },
        async create(input) {
            const created = { ...fixtureItem(input), id: `fixture-schedule-${items.length + 1}` };
            items = [created, ...items];
            return { ...created };
        },
        async update(id: string, patch: ScheduleWorkPatch) {
            const existing = items.find((item) => item.id === id);
            if (!existing) throw new Error('fixture item not found');
            const updated = { ...existing, ...patch, updatedAt: '2026-07-23T00:01:00.000Z' };
            items = items.map((item) => item.id === id ? updated : item);
            return { ...updated };
        },
        async remove(id: string) {
            items = items.filter((item) => item.id !== id);
        },
        async dispatch(id: string) {
            dispatchCalls += 1;
            const item = items.find((entry) => entry.id === id);
            if (!item) throw new Error('fixture item not found');
            if (dispatchStatus === 'claim-changed') claimChangedFixtureCalls += 1;
            const updated = dispatchStatus === 'dispatched' ? { ...item, enabled: false } : item;
            items = items.map((entry) => entry.id === id ? updated : entry);
            return {
                result: {
                    status: dispatchStatus,
                    message: dispatchStatus === 'claim-changed'
                        ? 'item changed before dispatch (injected claimForDispatch changed fixture)'
                        : `fixture ${dispatchStatus}`,
                    targetPort: updated.targetPort,
                },
                item: { ...updated },
            };
        },
    };

    const render = (): void => root?.render(<ScheduleView active={active} api={api} />);
    render();
    return {
        setActive(nextActive) {
            active = nextActive;
            render();
        },
        setDispatchStatus(status) {
            dispatchStatus = status;
        },
        metrics() {
            return { listCalls, dispatchCalls, claimChangedFixtureCalls };
        },
        unmount() {
            root?.unmount();
            root = null;
        },
    };
}

export function mountScheduleHttpHarness(target: HTMLElement): () => void {
    const root = createRoot(target);
    root.render(<ScheduleView active />);
    return () => root.unmount();
}
