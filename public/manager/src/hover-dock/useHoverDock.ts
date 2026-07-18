import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockTabKind } from './types';

const REVEAL_DELAY_MS = 150;
const HIDE_GRACE_MS = 200;

export type HoverDockState = {
    revealed: boolean;
    open: boolean;
    tab: DockTabKind;
    rootRef: React.RefObject<HTMLDivElement | null>;
    handleHotZoneEnter: () => void;
    handleHotZoneLeave: () => void;
    handlePillEnter: () => void;
    handlePillLeave: () => void;
    toggleOpen: () => void;
    setTab: (tab: DockTabKind) => void;
};

export function useHoverDock(): HoverDockState {
    const [revealed, setRevealed] = useState(false);
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<DockTabKind>('agents');
    const rootRef = useRef<HTMLDivElement | null>(null);
    const revealTimer = useRef<number | null>(null);
    const hideTimer = useRef<number | null>(null);

    const clearTimers = useCallback(() => {
        if (revealTimer.current !== null) {
            window.clearTimeout(revealTimer.current);
            revealTimer.current = null;
        }
        if (hideTimer.current !== null) {
            window.clearTimeout(hideTimer.current);
            hideTimer.current = null;
        }
    }, []);

    const scheduleHide = useCallback(() => {
        if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => {
            hideTimer.current = null;
            setRevealed(false);
        }, HIDE_GRACE_MS);
    }, []);

    const handleHotZoneEnter = useCallback(() => {
        if (hideTimer.current !== null) {
            window.clearTimeout(hideTimer.current);
            hideTimer.current = null;
        }
        if (revealed) return;
        if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
        revealTimer.current = window.setTimeout(() => {
            revealTimer.current = null;
            setRevealed(true);
        }, REVEAL_DELAY_MS);
    }, [revealed]);

    const handleHotZoneLeave = useCallback(() => {
        if (revealTimer.current !== null) {
            window.clearTimeout(revealTimer.current);
            revealTimer.current = null;
        }
        if (!open) scheduleHide();
    }, [open, scheduleHide]);

    const handlePillEnter = useCallback(() => {
        if (hideTimer.current !== null) {
            window.clearTimeout(hideTimer.current);
            hideTimer.current = null;
        }
        setRevealed(true);
    }, []);

    const handlePillLeave = useCallback(() => {
        if (!open) scheduleHide();
    }, [open, scheduleHide]);

    const toggleOpen = useCallback(() => {
        setOpen((prev) => {
            const next = !prev;
            if (next) setRevealed(true);
            return next;
        });
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

    useEffect(() => clearTimers, [clearTimers]);

    return {
        revealed,
        open,
        tab,
        rootRef,
        handleHotZoneEnter,
        handleHotZoneLeave,
        handlePillEnter,
        handlePillLeave,
        toggleOpen,
        setTab,
    };
}
