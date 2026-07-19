import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockTabKind } from './types';

export type HoverDockState = {
    open: boolean;
    tab: DockTabKind;
    rootRef: React.RefObject<HTMLDivElement | null>;
    toggleOpen: () => void;
    setTab: (tab: DockTabKind) => void;
};

export function useHoverDock(): HoverDockState {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<DockTabKind>('agents');
    const rootRef = useRef<HTMLDivElement | null>(null);

    const toggleOpen = useCallback(() => {
        setOpen((prev) => !prev);
    }, []);

    // Close on ESC / outside pointerdown while open.
    useEffect(() => {
        if (!open) return;
        function handleKeyDown(event: KeyboardEvent): void {
            if (event.key === 'Escape') setOpen(false);
        }
        function handlePointerDown(event: PointerEvent): void {
            const root = rootRef.current;
            if (!root) return;
            if (event.target instanceof Node && !root.contains(event.target)) {
                setOpen(false);
            }
        }
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('pointerdown', handlePointerDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('pointerdown', handlePointerDown);
        };
    }, [open]);

    return {
        open,
        tab,
        rootRef,
        toggleOpen,
        setTab,
    };
}
