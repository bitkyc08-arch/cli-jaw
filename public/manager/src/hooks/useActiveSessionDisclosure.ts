import { useEffect, useState } from 'react';
import { fetchChatSessions } from '../components/InstanceSessionList';

// Session disclosure state for the Active navigator row (devlog 260806 D2):
// count fetched once per selected instance to decide chevron visibility; the
// list itself is fetched lazily by InstanceSessionList only while open.
// Extracted from App.tsx to honor the 500-line dashboard budget; the WP4
// hardening cycle replaces the fetch here with the shared session store.
export function useActiveSessionDisclosure(activeSessionPort: number | null) {
    const [activeSessionCount, setActiveSessionCount] = useState(0);
    const [sessionsOpen, setSessionsOpen] = useState(false);

    useEffect(() => {
        setSessionsOpen(false);
        setActiveSessionCount(0);
        if (activeSessionPort == null) return;
        let cancelled = false;
        fetchChatSessions(activeSessionPort)
            .then(result => { if (!cancelled) setActiveSessionCount(result.sessions.length); })
            .catch(() => { /* offline or pre-session build: chevron simply stays hidden */ });
        return () => { cancelled = true; };
    }, [activeSessionPort]);

    return { activeSessionCount, sessionsOpen, setSessionsOpen };
}

