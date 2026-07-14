import { AlertCircle, CalendarClock, LoaderCircle, RefreshCw } from '@lucide/icons';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { fullDate, relativeTime } from './reminders-time.ts';
import { fetchScheduleWork, setScheduleWorkEnabled, type ScheduleGroup, type ScheduleWorkItem } from './schedule-api-adapter.ts';

interface ScheduleViewProps { active: boolean }

const GROUPS: Array<{ id: ScheduleGroup; label: string }> = [
    { id: 'today', label: 'Today' }, { id: 'upcoming', label: 'Upcoming' },
    { id: 'recurring', label: 'Recurring' }, { id: 'blocked', label: 'Blocked' },
];

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function ScheduleView({ active }: ScheduleViewProps): JSX.Element {
    const [items, setItems] = useState<ScheduleWorkItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

    const load = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        try { setItems(await fetchScheduleWork(signal)); setError(null); }
        catch (caught) { if (!signal?.aborted) setError(message(caught)); }
        finally { if (!signal?.aborted) setLoading(false); }
    }, []);

    useEffect(() => {
        if (!active) return undefined;
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [active, load]);

    const grouped = useMemo(() => GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.group === group.id) })), [items]);

    const toggle = async (item: ScheduleWorkItem): Promise<void> => {
        const previous = item;
        setBusyIds((current) => new Set(current).add(item.id));
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, enabled: !entry.enabled } : entry));
        setError(null);
        try {
            const updated = await setScheduleWorkEnabled(item.id, !item.enabled);
            setItems((current) => current.map((entry) => entry.id === item.id ? updated : entry));
        } catch (caught) {
            setItems((current) => current.map((entry) => entry.id === item.id ? previous : entry));
            setError(message(caught));
        } finally {
            setBusyIds((current) => { const next = new Set(current); next.delete(item.id); return next; });
        }
    };

    return (
        <div className="d2-schedule-view" hidden={!active} aria-busy={loading}>
            {error ? <div className="d2-reminders-error" role="alert"><Icon icon={AlertCircle} size={14} /><span>{error}</span><button type="button" onClick={() => void load()} aria-label="Retry schedule"><Icon icon={RefreshCw} size={13} /></button></div> : null}
            {loading && items.length === 0 ? <div className="d2-reminders-loading" role="status"><span className="d2-reminders-spinner"><Icon icon={LoaderCircle} size={16} /></span>Loading schedule...</div> : null}
            {!loading && !error && items.length === 0 ? <p className="d2-reminders-empty">No scheduled work.</p> : null}
            {grouped.map((group) => group.items.length > 0 ? (
                <section className="d2-schedule-group" key={group.id} aria-labelledby={`d2-schedule-${group.id}`}>
                    <div className="d2-reminders-section-heading"><h2 id={`d2-schedule-${group.id}`}>{group.label}</h2><span>{group.items.length}</span></div>
                    <ul className="d2-reminders-list">
                        {group.items.map((item) => {
                            const cadence = item.cron ? `Cron ${item.cron}` : item.runAt ? fullDate(item.runAt) : 'No run time';
                            return <li className="d2-reminders-schedule-row" data-disabled={!item.enabled} key={item.id}>
                                <span className="d2-reminders-schedule-icon"><Icon icon={CalendarClock} size={15} /></span>
                                <span className="d2-reminders-card-copy"><strong>{item.title}</strong><span>{cadence}</span>{item.lastStatus ? <span title={item.lastRunAt ? fullDate(item.lastRunAt) : undefined}>Last: {item.lastStatus}</span> : null}</span>
                                <span className="d2-reminders-schedule-status">{item.nextRunAt ? <time dateTime={item.nextRunAt} title={fullDate(item.nextRunAt)}>Next {relativeTime(item.nextRunAt)}</time> : <span>No next run</span>}</span>
                                <label className="d2-schedule-switch"><input type="checkbox" checked={item.enabled} disabled={busyIds.has(item.id)} onChange={() => void toggle(item)} /><span aria-hidden="true" /><b>{item.enabled ? 'Enabled' : 'Paused'}</b></label>
                            </li>;
                        })}
                    </ul>
                </section>
            ) : null)}
        </div>
    );
}
