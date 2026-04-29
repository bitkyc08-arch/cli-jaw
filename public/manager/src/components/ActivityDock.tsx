import { useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DashboardInstance, ManagerEvent } from '../types';
import { ActivityTimeline, type ActivityEntry } from './ActivityTimeline';

const MIN_ACTIVITY_HEIGHT = 88;
const MAX_ACTIVITY_HEIGHT = 320;

type ActivityDockProps = {
    collapsed: boolean;
    height: number;
    loading: boolean;
    error: string | null;
    lifecycleMessage: string | null;
    registryMessage: string | null;
    selectedInstance: DashboardInstance | null;
    events?: ManagerEvent[];
    onToggle: () => void;
    onHeightChange: (height: number) => void;
};

function clampActivityHeight(height: number): number {
    return Math.min(MAX_ACTIVITY_HEIGHT, Math.max(MIN_ACTIVITY_HEIGHT, Math.round(height)));
}

export function ActivityDock(props: ActivityDockProps) {
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
    const { onHeightChange } = props;
    const entries = useEntries(props);

    useEffect(() => {
        function handlePointerMove(event: PointerEvent): void {
            const drag = dragRef.current;
            if (!drag) return;
            onHeightChange(clampActivityHeight(drag.startHeight + drag.startY - event.clientY));
        }

        function handlePointerUp(): void {
            dragRef.current = null;
            document.body.classList.remove('is-resizing-activity');
        }

        document.addEventListener('pointermove', handlePointerMove);
        document.addEventListener('pointerup', handlePointerUp);
        return () => {
            document.removeEventListener('pointermove', handlePointerMove);
            document.removeEventListener('pointerup', handlePointerUp);
            document.body.classList.remove('is-resizing-activity');
        };
    }, [onHeightChange]);

    function handleResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
        if (props.collapsed) return;
        event.preventDefault();
        dragRef.current = { startY: event.clientY, startHeight: props.height };
        document.body.classList.add('is-resizing-activity');
    }

    return (
        <aside className={`activity-dock ${props.collapsed ? 'is-collapsed' : ''}`} aria-label="Activity dock">
            <button
                className="activity-resize-handle"
                type="button"
                aria-label="Resize activity dock"
                title="Resize activity dock"
                onPointerDown={handleResizePointerDown}
                disabled={props.collapsed}
            />
            <div className="activity-header">
                <span>Activity</span>
                <button type="button" onClick={props.onToggle}>
                    {props.collapsed ? 'Expand' : 'Collapse'}
                </button>
            </div>
            {!props.collapsed && (
                <ActivityTimeline entries={entries} />
            )}
        </aside>
    );
}

function useEntries(props: ActivityDockProps): Array<ActivityEntry | ManagerEvent> {
    return useMemo(() => {
        const out: Array<ActivityEntry | ManagerEvent> = [];
        if (props.events && props.events.length > 0) {
            // Show newest first; ActivityTimeline groups bucketize chronologically.
            for (const event of props.events) out.push(event);
        }
        const now = new Date().toISOString();
        if (props.error) out.push({ at: now, source: 'error', message: props.error });
        if (props.registryMessage) out.push({ at: now, source: 'registry', message: props.registryMessage });
        if (props.lifecycleMessage) out.push({ at: now, source: 'lifecycle', message: props.lifecycleMessage });
        if (out.length === 0) {
            out.push({ at: now, source: 'scan', message: props.loading ? 'scanning local ports' : 'no recent activity' });
        }
        return out;
    }, [
        props.events,
        props.loading,
        props.error,
        props.registryMessage,
        props.lifecycleMessage,
    ]);
}
