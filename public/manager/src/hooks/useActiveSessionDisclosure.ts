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

// Active disclosure defaults open on each selected online port.
// The hook and list share the same cached/in-flight load; the list also
// exposes initial loading and failure before any sessions are known.
// Extracted from App.tsx to honor the 500-line dashboard budget; the WP4
// hardening cycle replaces the fetch here with the shared session store.
export function useActiveSessionDisclosure(activeSessionPort: number | null) {
    const [sessionsOpen, setSessionsOpen] = useState(true);
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
        setSessionsOpen(true);
        if (activeSessionPort == null) return;
        void loadSessions(activeSessionPort)
            .catch(() => { /* offline or pre-session build: chevron simply stays hidden */ });
    }, [activeSessionPort]);

    return { activeSessionCount: snapshot.count, sessionsOpen, setSessionsOpen };
}
