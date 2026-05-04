import { useEffect, useRef } from 'react';
import { fetchNotesVersion } from '../api';
import { publishInvalidation } from '../sync/invalidation-bus';

const POLL_INTERVAL_MS = 5_000;

export function useNotesExternalSync(active: boolean): void {
    const versionRef = useRef<number | null>(null);

    useEffect(() => {
        if (!active) return;

        let cancelled = false;

        async function poll(): Promise<void> {
            try {
                const version = await fetchNotesVersion();
                if (cancelled) return;
                if (versionRef.current !== null && version !== versionRef.current) {
                    publishInvalidation({
                        topics: ['notes'],
                        reason: 'notes:external-change',
                        source: 'visibility',
                        sourceId: 'external-sync',
                    });
                }
                versionRef.current = version;
            } catch {
                // server unreachable — skip
            }
        }

        void poll();
        const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, [active]);
}
