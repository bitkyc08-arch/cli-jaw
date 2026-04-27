import { useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DashboardInstance } from '../types';
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
    previewMode: string;
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

function useEntries(props: ActivityDockProps): ActivityEntry[] {
    return useMemo(() => {
        const now = new Date().toISOString();
        const out: ActivityEntry[] = [];
        out.push({
            at: now,
            source: 'scan',
            message: props.loading ? 'scanning local ports' : 'latest scan loaded',
        });
        if (props.error) out.push({ at: now, source: 'error', message: props.error });
        if (props.registryMessage) out.push({ at: now, source: 'registry', message: props.registryMessage });
        if (props.lifecycleMessage) out.push({ at: now, source: 'lifecycle', message: props.lifecycleMessage });
        out.push({
            at: now,
            source: 'selected',
            message: props.selectedInstance ? `:${props.selectedInstance.port}` : 'none',
        });
        out.push({
            at: now,
            source: 'preview',
            message: props.previewMode === 'proxy' ? 'proxy path is primary' : 'direct iframe is best-effort',
        });
        return out;
    }, [
        props.loading,
        props.error,
        props.registryMessage,
        props.lifecycleMessage,
        props.selectedInstance,
        props.previewMode,
    ]);
}
