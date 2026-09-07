import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
    getSessionSnapshot,
    loadSessions,
    subscribeSessions,
    type SessionsSnapshot,
} from '../lib/session-store';

const EMPTY_SESSIONS_SNAPSHOT: SessionsSnapshot = {
    data: null,
    switching: false,
    error: null,
    count: 0,
};

// Session disclosure state for the Active navigator row:
// count fetched once per selected instance to decide chevron visibility; the
// list itself is fetched lazily by InstanceSessionList only while open.
// Extracted from App.tsx to honor the 500-line dashboard budget; the WP4
// hardening cycle replaces the fetch here with the shared session store.
export function useActiveSessionDisclosure(activeSessionPort: number | null) {
    const [sessionsOpen, setSessionsOpen] = useState(false);
    const subscribe = useCallback(
        (callback: () => void) => activeSessionPort == null
            ? () => {}
            : subscribeSessions(activeSessionPort, callback),
        [activeSessionPort],
    );
    const getSnapshot = useCallback(
        () => activeSessionPort == null
            ? EMPTY_SESSIONS_SNAPSHOT
            : getSessionSnapshot(activeSessionPort),
        [activeSessionPort],
    );
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);

    useEffect(() => {
        setSessionsOpen(false);
        if (activeSessionPort == null) return;
        void loadSessions(activeSessionPort)
            .catch(() => { /* offline or pre-session build: chevron simply stays hidden */ });
    }, [activeSessionPort]);

    return { activeSessionCount: snapshot.count, sessionsOpen, setSessionsOpen };
}
