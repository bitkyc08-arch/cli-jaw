// Phase 9 — `⌘+S` / `Ctrl+S` keyboard hook.
//
// Binds at document level so any focused input inside the settings shell
// triggers save. We `preventDefault` to suppress the browser's "Save Page"
// dialog. Listener is gated on `enabled` and on the shell containing the
// active focus so we don't hijack ⌘+S elsewhere on the page.

import { useEffect } from 'react';
import type { RefObject } from 'react';

type Options = {
    enabled: boolean;
    containerRef: RefObject<HTMLElement | null>;
    onSave: () => void;
};

export function useSaveShortcut({ enabled, containerRef, onSave }: Options): void {
    useEffect(() => {
        if (!enabled) return;
        function handler(event: KeyboardEvent) {
            if (event.key !== 's' && event.key !== 'S') return;
            if (!(event.metaKey || event.ctrlKey)) return;
            if (event.altKey || event.shiftKey) return;
            const container = containerRef.current;
            if (!container) return;
            const target = event.target;
            const targetNode = target instanceof Node ? target : null;
            if (targetNode && !container.contains(targetNode)) return;
            event.preventDefault();
            onSave();
        }
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [enabled, containerRef, onSave]);
}
