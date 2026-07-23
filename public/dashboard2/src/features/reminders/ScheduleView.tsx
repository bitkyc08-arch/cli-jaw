import { AlertCircle, CalendarClock, Edit3, LoaderCircle, Plus, RefreshCw, Send } from '@lucide/icons';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { fullDate, relativeTime } from './reminders-time.ts';
import {
    scheduleApi,
    type ScheduleApi,
    type ScheduleDispatchResult,
    type ScheduleDispatchStatus,
    type ScheduleGroup,
    type ScheduleWorkInput,
    type ScheduleWorkItem,
} from './schedule-api-adapter.ts';
import { ScheduleWorkEditor } from './ScheduleWorkEditor.tsx';

export interface ScheduleViewProps {
    active: boolean;
    api?: ScheduleApi;
}

const POLL_INTERVAL_MS = 30_000;
const GROUPS: Array<{ id: ScheduleGroup; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'recurring', label: 'Recurring' },
    { id: 'blocked', label: 'Blocked' },
];
const DISPATCH_LABELS: Record<ScheduleDispatchStatus, string> = {
    disabled: 'Dispatch 판정: 비활성',
    no_target: 'Dispatch 판정: 대상 없음',
    queued: 'Dispatch 판정: 대기열 유지',
    dispatched: 'Dispatch 판정: 전달 준비 · claim 완료',
    'claim-changed': 'Dispatch 판정: claim 변경 감지',
};

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function upsert(items: ScheduleWorkItem[], item: ScheduleWorkItem): ScheduleWorkItem[] {
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index < 0) return [item, ...items];
    return items.map((entry) => entry.id === item.id ? item : entry);
}

interface ScheduleRowProps {
    item: ScheduleWorkItem;
    busy: boolean;
    decision?: ScheduleDispatchResult;
    onToggle(item: ScheduleWorkItem): void;
    onEdit(item: ScheduleWorkItem): void;
    onDispatch(item: ScheduleWorkItem): void;
}

function ScheduleRow({ item, busy, decision, onToggle, onEdit, onDispatch }: ScheduleRowProps): JSX.Element {
    const cadence = item.cron ? `Cron ${item.cron}` : item.runAt ? fullDate(item.runAt) : 'No run time';
    return (
        <li className="d2-reminders-schedule-row" data-disabled={!item.enabled} data-dispatch-status={decision?.status ?? ''}>
            <span className="d2-reminders-schedule-icon"><Icon icon={CalendarClock} size={15} /></span>
            <span className="d2-reminders-card-copy">
                <strong>{item.title}</strong>
                <span>{cadence}{item.targetPort === null ? '' : ` · :${item.targetPort}`}</span>
                {item.lastStatus ? <span title={item.lastRunAt ? fullDate(item.lastRunAt) : undefined}>Last: {item.lastStatus}</span> : null}
                {decision ? <span className="d2-schedule-dispatch-result" role="status" title={decision.message}>{DISPATCH_LABELS[decision.status]}</span> : null}
            </span>
            <span className="d2-reminders-schedule-status">{item.nextRunAt ? <time dateTime={item.nextRunAt} title={fullDate(item.nextRunAt)}>Next {relativeTime(item.nextRunAt)}</time> : <span>No next run</span>}</span>
            <span className="d2-schedule-row-actions">
                <button type="button" disabled={busy} onClick={() => onDispatch(item)} aria-label={`Dispatch 판정: ${item.title}`} title="Dispatch 판정 (실행 아님)"><Icon icon={Send} size={14} /></button>
                <button type="button" disabled={busy} onClick={() => onEdit(item)} aria-label={`Edit scheduled work ${item.title}`} title="Edit"><Icon icon={Edit3} size={14} /></button>
                <label className="d2-schedule-switch"><input type="checkbox" checked={item.enabled} disabled={busy} onChange={() => onToggle(item)} /><span aria-hidden="true" /><b>{item.enabled ? 'Enabled' : 'Paused'}</b></label>
            </span>
        </li>
    );
}

export function ScheduleView({ active, api = scheduleApi }: ScheduleViewProps): JSX.Element {
    const [items, setItems] = useState<ScheduleWorkItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
    const [showCreate, setShowCreate] = useState(false);
    const [creating, setCreating] = useState(false);
    const [editingItem, setEditingItem] = useState<ScheduleWorkItem | null>(null);
    const [dispatchByItem, setDispatchByItem] = useState<Record<string, ScheduleDispatchResult>>({});

    const load = useCallback(async (showLoading: boolean, signal?: AbortSignal): Promise<void> => {
        if (showLoading) setLoading(true);
        try {
            const nextItems = await api.list(signal);
            if (!signal?.aborted) {
                setItems(nextItems);
                setError(null);
            }
        } catch (caught) {
            if (!signal?.aborted) setError(message(caught));
        } finally {
            if (showLoading && !signal?.aborted) setLoading(false);
        }
    }, [api]);

    useEffect(() => {
        if (!active) return undefined;
        let controller: AbortController | null = null;
        let timer: number | undefined;
        const stop = (): void => {
            if (timer !== undefined) window.clearInterval(timer);
            timer = undefined;
            controller?.abort();
            controller = null;
        };
        const refresh = (showLoading: boolean): void => {
            controller?.abort();
            controller = new AbortController();
            void load(showLoading, controller.signal);
        };
        const start = (showLoading: boolean): void => {
            if (document.hidden) return;
            refresh(showLoading);
            timer = window.setInterval(() => refresh(false), POLL_INTERVAL_MS);
        };
        const onVisibilityChange = (): void => {
            stop();
            if (!document.hidden) start(true);
        };
        start(true);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            stop();
        };
    }, [active, load]);

    const grouped = useMemo(() => GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.group === group.id) })), [items]);

    const withBusyItem = useCallback(async (id: string, action: () => Promise<void>): Promise<void> => {
        setBusyIds((current) => new Set(current).add(id));
        setError(null);
        try {
            await action();
        } catch (caught) {
            setError(message(caught));
        } finally {
            setBusyIds((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
            });
        }
    }, []);

    const toggle = (item: ScheduleWorkItem): void => {
        const previous = item;
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, enabled: !entry.enabled } : entry));
        void withBusyItem(item.id, async () => {
            try {
                const updated = await api.update(item.id, { enabled: !item.enabled });
                setItems((current) => upsert(current, updated));
            } catch (caught) {
                setItems((current) => current.map((entry) => entry.id === item.id ? previous : entry));
                throw caught;
            }
        });
    };

    const dispatch = (item: ScheduleWorkItem): void => {
        void withBusyItem(item.id, async () => {
            const response = await api.dispatch(item.id);
            setItems((current) => upsert(current, response.item));
            setDispatchByItem((current) => ({ ...current, [item.id]: response.result }));
        });
    };

    const save = async (input: ScheduleWorkInput): Promise<void> => {
        const id = editingItem?.id;
        if (id) {
            await withBusyItem(id, async () => {
                const updated = await api.update(id, input);
                setItems((current) => upsert(current, updated));
                setEditingItem(null);
            });
            return;
        }
        setCreating(true);
        setError(null);
        try {
            const created = await api.create(input);
            setItems((current) => upsert(current, created));
            setShowCreate(false);
        } catch (caught) {
            setError(message(caught));
        } finally {
            setCreating(false);
        }
    };

    const remove = async (item: ScheduleWorkItem): Promise<void> => {
        await withBusyItem(item.id, async () => {
            await api.remove(item.id);
            setItems((current) => current.filter((entry) => entry.id !== item.id));
            setEditingItem(null);
            setDispatchByItem((current) => {
                const next = { ...current };
                delete next[item.id];
                return next;
            });
        });
    };

    return (
        <div id="d2-reminders-schedule-panel" className="d2-schedule-view" role="tabpanel" aria-label="Schedule" hidden={!active} aria-busy={loading}>
            <div className="d2-reminders-section-heading d2-schedule-heading"><h2>Scheduled work</h2><span>{items.length}</span><button type="button" onClick={() => setShowCreate(true)} aria-label="Create scheduled work" title="Create scheduled work"><Icon icon={Plus} size={14} /></button></div>
            <p className="d2-schedule-decision-note">Dispatch 판정은 대상 선택과 one-shot claim만 수행하며 실제 작업을 실행하지 않습니다.</p>
            {error ? <div className="d2-reminders-error" role="alert"><Icon icon={AlertCircle} size={14} /><span>{error}</span><button type="button" onClick={() => void load(true)} aria-label="Retry schedule"><Icon icon={RefreshCw} size={13} /></button></div> : null}
            {loading && items.length === 0 ? <div className="d2-reminders-loading" role="status"><span className="d2-reminders-spinner"><Icon icon={LoaderCircle} size={16} /></span>Loading schedule...</div> : null}
            {!loading && !error && items.length === 0 ? <p className="d2-reminders-empty">No scheduled work.</p> : null}
            {grouped.map((group) => group.items.length > 0 ? (
                <section className="d2-schedule-group" key={group.id} aria-labelledby={`d2-schedule-${group.id}`}>
                    <div className="d2-reminders-section-heading"><h2 id={`d2-schedule-${group.id}`}>{group.label}</h2><span>{group.items.length}</span></div>
                    <ul className="d2-reminders-list">{group.items.map((item) => <ScheduleRow key={item.id} item={item} busy={busyIds.has(item.id)} decision={dispatchByItem[item.id]} onToggle={toggle} onEdit={setEditingItem} onDispatch={dispatch} />)}</ul>
                </section>
            ) : null)}
            {showCreate ? <ScheduleWorkEditor item={null} busy={creating} onClose={() => setShowCreate(false)} onSave={save} /> : null}
            {editingItem ? <ScheduleWorkEditor item={editingItem} busy={busyIds.has(editingItem.id)} onClose={() => setEditingItem(null)} onSave={save} onDelete={remove} /> : null}
        </div>
    );
}
