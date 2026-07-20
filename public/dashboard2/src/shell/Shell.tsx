import { useCallback, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { Sidebar } from './Sidebar.tsx';
import { Workbench } from './Workbench.tsx';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;

export function Shell(): JSX.Element {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
    const shellRef = useRef<HTMLElement>(null);

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
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
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
            <Sidebar onClose={() => setSidebarCollapsed(true)} />
            {!sidebarCollapsed ? (
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
            ) : null}
            <Workbench
                sidebarCollapsed={sidebarCollapsed}
                onOpenSidebar={() => setSidebarCollapsed(false)}
            />
        </main>
    );
}
