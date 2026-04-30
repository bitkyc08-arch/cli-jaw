import { useMemo, useState } from 'react';
import { countUnreadActivityEventsByPort, latestManagerEventAt, latestManagerEventAtForPort } from '../activity-unread';
import type { DashboardRegistryUi, ManagerEvent } from '../types';

type ActivityUiPatch = Pick<Partial<DashboardRegistryUi>, 'activityDockCollapsed' | 'activitySeenAt' | 'activitySeenByPort'>;

type UseActivityUnreadOptions = {
    events: ManagerEvent[];
    activityDockCollapsed: boolean;
    setActivityDockCollapsed: (collapsed: boolean) => void;
    saveUi: (ui: ActivityUiPatch) => Promise<void>;
    // Port whose iframe is currently being viewed in the workbench. Its badge
    // is suppressed so the user does not see "(1)" for the instance they are
    // already watching. Other ports are unaffected (devlog 260501).
    activePreviewPort: number | null;
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

    // Per-port unread counts. Each port is gated by its own seenByPort entry
    // only — no cross-port wipe when the dock opens, no global ceiling. The
    // currently-viewed iframe's port is suppressed via activePreviewPort.
    const unreadByPort = useMemo(() => {
        return countUnreadActivityEventsByPort(
            options.events,
            seenActivityAt,
            seenActivityByPort,
            options.activePreviewPort,
        );
    }, [options.events, seenActivityAt, seenActivityByPort, options.activePreviewPort]);

    function hydrateSeenAt(seenAt: string | null, seenByPort: Record<string, string>): void {
        setSeenActivityAt(seenAt);
        setSeenActivityByPort(Object.fromEntries(
            Object.entries(seenByPort).map(([port, value]) => [Number(port), value]),
        ));
    }

    function markPortSeen(port: number): void {
        const latest = latestManagerEventAtForPort(options.events, port);
        if (!latest) return;
        const portSeenAt = seenActivityByPort[port] || null;
        if (portSeenAt && Date.parse(latest) <= Date.parse(portSeenAt)) return;
        const next = { ...seenActivityByPort, [port]: latest };
        setSeenActivityByPort(next);
        void options.saveUi({
            activitySeenByPort: Object.fromEntries(Object.entries(next).map(([key, value]) => [String(key), value])),
        });
    }

    function openAndMarkSeen(): void {
        // Materialize per-port latest-seen for every port that currently has
        // events. Never reset the map to {} — that destroys the per-port
        // suppression state on which the badge logic depends.
        const latest = latestManagerEventAt(options.events);
        const next: Record<number, string> = { ...seenActivityByPort };
        for (const event of options.events) {
            if (!('port' in event)) continue;
            const existing = next[event.port];
            if (!existing || Date.parse(event.at) > Date.parse(existing)) {
                next[event.port] = event.at;
            }
        }
        setSeenActivityAt(latest);
        setSeenActivityByPort(next);
        options.setActivityDockCollapsed(false);
        void options.saveUi({
            activityDockCollapsed: false,
            activitySeenAt: latest,
            activitySeenByPort: Object.fromEntries(Object.entries(next).map(([key, value]) => [String(key), value])),
        });
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
