import { useCallback, useEffect, useState } from 'react';
import {
    createReminder,
    listReminders,
    markReminderDone,
    snoozeReminder,
    updateReminder,
    type DashboardReminder,
    type DashboardReminderCreateInput,
    type DashboardReminderPatchInput,
} from './reminders-api';

export type RemindersFeedState = {
    items: DashboardReminder[];
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    create: (input: DashboardReminderCreateInput) => Promise<void>;
    update: (id: string, patch: DashboardReminderPatchInput) => Promise<void>;
    markDone: (id: string) => Promise<void>;
    snooze: (id: string, nextRemindAt: string) => Promise<void>;
};

type UseRemindersFeedOptions = {
    active: boolean;
    pollWhileActiveMs?: number;
};

export function useRemindersFeed(options: UseRemindersFeedOptions): RemindersFeedState {
    const [items, setItems] = useState<DashboardReminder[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        setError(null);
        try {
            const body = await listReminders();
            setItems(body.items || []);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        await load();
    }, [load]);

    const create = useCallback(async (input: DashboardReminderCreateInput): Promise<void> => {
        setError(null);
        try {
            const item = await createReminder(input);
            setItems(current => [item, ...current.filter(existing => existing.id !== item.id)]);
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);

    const update = useCallback(async (id: string, patch: DashboardReminderPatchInput): Promise<void> => {
        setError(null);
        try {
            const item = await updateReminder(id, patch);
            setItems(current => current.map(existing => existing.id === id ? item : existing));
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);

    const markDone = useCallback(async (id: string): Promise<void> => {
        setError(null);
        let previous: DashboardReminder[] = [];
        setItems(current => {
            previous = current;
            return current.map(existing => existing.id === id ? { ...existing, status: 'done' } : existing);
        });
        try {
            const item = await markReminderDone(id);
            setItems(current => current.map(existing => existing.id === id ? item : existing));
        } catch (err) {
            setItems(previous);
            setError((err as Error).message);
        }
    }, []);

    const snooze = useCallback(async (id: string, nextRemindAt: string): Promise<void> => {
        setError(null);
        try {
            const item = await snoozeReminder(id, nextRemindAt);
            setItems(current => current.map(existing => existing.id === id ? item : existing));
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);

    useEffect(() => {
        if (!options.active) return;
        void load();
    }, [options.active, load]);

    useEffect(() => {
        if (!options.active || !options.pollWhileActiveMs) return undefined;
        const timer = window.setInterval(() => {
            if (document.hidden) return;
            void load();
        }, options.pollWhileActiveMs);
        return () => window.clearInterval(timer);
    }, [options.active, options.pollWhileActiveMs, load]);

    useEffect(() => {
        if (!options.active || !options.pollWhileActiveMs) return undefined;
        const refreshIfVisible = (): void => {
            if (document.hidden) return;
            void load();
        };
        window.addEventListener('focus', refreshIfVisible);
        document.addEventListener('visibilitychange', refreshIfVisible);
        return () => {
            window.removeEventListener('focus', refreshIfVisible);
            document.removeEventListener('visibilitychange', refreshIfVisible);
        };
    }, [options.active, options.pollWhileActiveMs, load]);

    return { items, loading, error, refresh, create, update, markDone, snooze };
}
