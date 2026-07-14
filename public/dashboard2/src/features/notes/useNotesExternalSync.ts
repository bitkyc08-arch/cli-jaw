import { useEffect, useRef } from 'react';
import { fetchNotesVersion } from './notes-api';

const POLL_INTERVAL_MS = 5_000;

export function useNotesExternalSync(active: boolean, onExternalChange: () => void): void {
    const versionRef = useRef<number | null>(null);
    const onExternalChangeRef = useRef(onExternalChange);
    onExternalChangeRef.current = onExternalChange;

    useEffect(() => {
        if (!active) return;
        let cancelled = false;

        async function poll(): Promise<void> {
            try {
                const version = await fetchNotesVersion();
                if (cancelled) return;
                if (versionRef.current !== null && version !== versionRef.current) {
                    onExternalChangeRef.current();
                }
                versionRef.current = version;
            } catch {
                // Server unreachable; retry on the next interval.
            }
        }

        void poll();
        const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, [active]);
}
