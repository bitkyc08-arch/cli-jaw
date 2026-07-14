import { AlertCircle, CalendarClock, LoaderCircle, RefreshCw } from '@lucide/icons';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { listScheduledItems } from './reminders-api-adapter.ts';
import { RemindersCore } from './RemindersCore.tsx';
import { dateScore, fullDate, relativeTime } from './reminders-time.ts';
import type { ScheduledItem } from './reminders-types.ts';

interface RemindersPanelProps {
    active: boolean;
}

const POLL_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function ScheduleRow({ item }: { item: ScheduledItem }): JSX.Element {
    const cadence = item.cron ? `Cron ${item.cron}` : item.runAt ? `Run ${fullDate(item.runAt)}` : 'No run time';
    const state = item.enabled ? 'Enabled' : 'Paused';
    return (
        <li className="d2-reminders-schedule-row" data-disabled={!item.enabled}>
            <span className="d2-reminders-schedule-icon"><Icon icon={CalendarClock} size={15} /></span>
            <span className="d2-reminders-card-copy">
                <strong title={item.title}>{item.title}</strong>
                <span title={cadence}>{cadence}</span>
            </span>
            <span className="d2-reminders-schedule-status">
                <strong>{state}</strong>
                {item.nextRunAt ? <time dateTime={item.nextRunAt} title={`Next ${fullDate(item.nextRunAt)}`}>Next {relativeTime(item.nextRunAt)}</time> : null}
                {item.lastStatus ? <span title={item.lastRunAt ? fullDate(item.lastRunAt) : undefined}>Last {item.lastStatus}</span> : null}
            </span>
        </li>
    );
}

export function RemindersPanel({ active }: RemindersPanelProps): JSX.Element {
    const [scheduledItems, setScheduledItems] = useState<ScheduledItem[]>([]);
    const [scheduleError, setScheduleError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const loadSchedule = useCallback(async (showLoading: boolean, signal?: AbortSignal): Promise<void> => {
        if (showLoading) setLoading(true);
        try {
            const items = await listScheduledItems(signal);
            if (signal?.aborted) return;
            setScheduledItems(items);
            setScheduleError(null);
        } catch (error) {
            if (signal?.aborted) return;
            setScheduleError(errorMessage(error));
        } finally {
            if (showLoading && !signal?.aborted) setLoading(false);
        }
    }, []);

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
            void loadSchedule(showLoading, controller.signal);
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
    }, [active, loadSchedule]);

    const sortedScheduledItems = useMemo(() => [...scheduledItems]
        .sort((left, right) => dateScore(left.nextRunAt ?? left.runAt) - dateScore(right.nextRunAt ?? right.runAt)), [scheduledItems]);

    return (
        <div className="d2-feature-panel d2-reminders-panel" style={{ display: active ? undefined : 'none' }}>
            <header className="d2-reminders-toolbar">
                <div>
                    <strong>Reminders &amp; Schedule</strong>
                    <span>{sortedScheduledItems.length} scheduled tasks</span>
                </div>
            </header>

            <div className="d2-reminders-scroll">
                <RemindersCore variant="panel" active={active} />

                <section className="d2-reminders-section d2-reminders-schedule-section" aria-labelledby="d2-reminders-scheduled-title">
                    <div className="d2-reminders-section-heading">
                        <h2 id="d2-reminders-scheduled-title">Scheduled Tasks</h2>
                        <span>{sortedScheduledItems.length}</span>
                    </div>
                    {scheduleError ? (
                        <div className="d2-reminders-error" role="alert">
                            <Icon icon={AlertCircle} size={14} />
                            <span>{scheduleError}</span>
                            <button type="button" onClick={() => void loadSchedule(true)} title="Retry schedule" aria-label="Retry schedule"><Icon icon={RefreshCw} size={13} /></button>
                        </div>
                    ) : loading && scheduledItems.length === 0 ? (
                        <div className="d2-reminders-loading" role="status"><span className="d2-reminders-spinner"><Icon icon={LoaderCircle} size={16} /></span>Loading schedule...</div>
                    ) : sortedScheduledItems.length > 0 ? (
                        <ul className="d2-reminders-list">
                            {sortedScheduledItems.map((item) => <ScheduleRow key={item.id} item={item} />)}
                        </ul>
                    ) : (
                        <p className="d2-reminders-empty">No scheduled tasks.</p>
                    )}
                </section>
            </div>
        </div>
    );
}
