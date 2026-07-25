import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { Sidebar } from './Sidebar.tsx';
import { Workbench } from './Workbench.tsx';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;

/** Viewport width below which the sidebar auto-collapses. */
const RESPONSIVE_BREAKPOINT = 1024;

export function Shell(): JSX.Element {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
    const shellRef = useRef<HTMLElement>(null);
    /**
     * Tracks whether the current collapsed state was caused by the responsive
     * auto-collapse (true) or by the user clicking the sidebar toggle (false).
     * When the viewport widens past the breakpoint we only restore the sidebar
     * if it was auto-collapsed — a manual close is respected across resizes.
     */
    const autoCollapsedRef = useRef(false);

    useEffect(() => {
        const mql = window.matchMedia(`(max-width: ${RESPONSIVE_BREAKPOINT - 1}px)`);

        const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
            if (e.matches) {
                // Viewport dropped below breakpoint → auto-collapse if open
                setSidebarCollapsed((prev) => {
                    if (!prev) {
                        autoCollapsedRef.current = true;
                        return true;
                    }
                    return prev;
                });
            } else {
                // Viewport widened above breakpoint → restore only if auto-collapsed
                if (autoCollapsedRef.current) {
                    autoCollapsedRef.current = false;
                    setSidebarCollapsed(false);
                }
            }
        };

        // Evaluate on mount so SSR/late hydration starts in the right state
        handleChange(mql);
        mql.addEventListener('change', handleChange);
        return () => mql.removeEventListener('change', handleChange);
    }, []);

    const onResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.classList.add('is-dragging');
        handle.setPointerCapture(e.pointerId);

        const move = (ev: PointerEvent) => {
            const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX));
            setSidebarWidth(next);
            if (shellRef.current) {
                shellRef.current.style.setProperty('--d2-sidebar-w', `${next}px`);
            }
        };
        const up = () => {
            handle.classList.remove('is-dragging');
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            // A cancelled pointer sequence never sends pointerup, so without this
            // the drag listeners and the is-dragging class outlive the gesture.
            // Workbench's divider already handles it this way.
            document.removeEventListener('pointercancel', up);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
    }, []);

    const onResizeKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        let next = sidebarWidth;
        const step = e.shiftKey ? 50 : 10;
        switch (e.key) {
            case 'ArrowLeft':
                next = Math.max(SIDEBAR_MIN, sidebarWidth - step);
                break;
            case 'ArrowRight':
                next = Math.min(SIDEBAR_MAX, sidebarWidth + step);
                break;
            case 'Home':
                next = SIDEBAR_MIN;
                break;
            case 'End':
                next = SIDEBAR_MAX;
                break;
            default:
                return;
        }
        e.preventDefault();
        setSidebarWidth(next);
        if (shellRef.current) {
            shellRef.current.style.setProperty('--d2-sidebar-w', `${next}px`);
        }
    }, [sidebarWidth]);

    return (
        <main
            id="d2-workbench-main"
            ref={shellRef}
            className={sidebarCollapsed ? 'd2-shell d2-sb-closed' : 'd2-shell'}
            style={!sidebarCollapsed ? { '--d2-sidebar-w': `${sidebarWidth}px` } as React.CSSProperties : undefined}
        >
            <a href="#d2-chat-area" className="d2-skip-nav">Skip to main content</a>
            <h1 className="d2-sr-only">cli-jaw dashboard</h1>
            <Sidebar
                collapsed={sidebarCollapsed}
                onClose={() => {
                    // User explicitly closed → mark as manual so auto-restore skips it
                    autoCollapsedRef.current = false;
                    setSidebarCollapsed(true);
                    /*
                     * The close button is inside the subtree that is about to go
                     * inert, so focus would be stranded on an unreachable node.
                     * Hand it to the workbench header button that reopens the
                     * sidebar, which mounts as part of this same state change.
                     */
                    requestAnimationFrame(() => {
                        shellRef.current
                            ?.querySelector<HTMLElement>('.d2-workbench-side-toggle-open')
                            ?.focus();
                    });
                }}
            />
            {!sidebarCollapsed && (
                <div
                    className="d2-sidebar-resize"
                    role="separator"
                    aria-orientation="vertical"
                    aria-valuenow={sidebarWidth}
                    aria-valuemin={SIDEBAR_MIN}
                    aria-valuemax={SIDEBAR_MAX}
                    tabIndex={0}
                    onPointerDown={onResizeStart}
                    onKeyDown={onResizeKeyDown}
                />
            )}
            <Workbench
                sidebarCollapsed={sidebarCollapsed}
                onOpenSidebar={() => {
                    // User explicitly opened → clear auto-collapsed flag
                    autoCollapsedRef.current = false;
                    setSidebarCollapsed(false);
                }}
            />
        </main>
    );
}
