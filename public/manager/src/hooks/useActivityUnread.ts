import { useEffect, useMemo, useState } from 'react';
import { countUnreadActivityEventsByPort, latestManagerEventAt, latestManagerEventAtForPort } from '../activity-unread';
import type { DashboardRegistryUi, ManagerEvent } from '../types';

type ActivityUiPatch = Pick<Partial<DashboardRegistryUi>, 'activityDockCollapsed' | 'activitySeenAt' | 'activitySeenByPort'>;

type UseActivityUnreadOptions = {
    events: ManagerEvent[];
    activityDockCollapsed: boolean;
    setActivityDockCollapsed: (collapsed: boolean) => void;
    saveUi: (ui: ActivityUiPatch) => Promise<void>;
};

type UseActivityUnreadResult = {
    unreadByPort: Record<number, number>;
    hydrateSeenAt: (seenAt: string | null, seenByPort: Record<string, string>) => void;
    markPortSeen: (port: number) => void;
    openAndMarkSeen: () => void;
    closeAndPersistSeen: () => void;
};

export function useActivityUnread(options: UseActivityUnreadOptions): UseActivityUnreadResult {
    const [seenActivityAt, setSeenActivityAt] = useState<string | null>(null);
    const [seenActivityByPort, setSeenActivityByPort] = useState<Record<number, string>>({});

    const unreadByPort = useMemo(() => {
        if (!options.activityDockCollapsed) return {};
        return countUnreadActivityEventsByPort(options.events, seenActivityAt, seenActivityByPort);
    }, [options.activityDockCollapsed, options.events, seenActivityAt, seenActivityByPort]);

    useEffect(() => {
        if (options.activityDockCollapsed) return;
        const latest = latestManagerEventAt(options.events);
        if (!latest || latest === seenActivityAt) return;
        setSeenActivityAt(latest);
    }, [options.activityDockCollapsed, options.events, seenActivityAt]);

    function hydrateSeenAt(seenAt: string | null, seenByPort: Record<string, string>): void {
        setSeenActivityAt(seenAt);
        setSeenActivityByPort(Object.fromEntries(
            Object.entries(seenByPort).map(([port, value]) => [Number(port), value]),
        ));
    }

    function markPortSeen(port: number): void {
        const latest = latestManagerEventAtForPort(options.events, port);
        if (!latest) return;
        const next = { ...seenActivityByPort, [port]: latest };
        setSeenActivityByPort(next);
        void options.saveUi({
            activitySeenByPort: Object.fromEntries(Object.entries(next).map(([key, value]) => [String(key), value])),
        });
    }

    function openAndMarkSeen(): void {
        const latest = latestManagerEventAt(options.events);
        setSeenActivityAt(latest);
        setSeenActivityByPort({});
        options.setActivityDockCollapsed(false);
        void options.saveUi({ activityDockCollapsed: false, activitySeenAt: latest, activitySeenByPort: {} });
    }

    function closeAndPersistSeen(): void {
        options.setActivityDockCollapsed(true);
        void options.saveUi({
            activityDockCollapsed: true,
            activitySeenAt: seenActivityAt,
            activitySeenByPort: Object.fromEntries(Object.entries(seenActivityByPort).map(([key, value]) => [String(key), value])),
        });
    }

    return { unreadByPort, hydrateSeenAt, markPortSeen, openAndMarkSeen, closeAndPersistSeen };
}
