import { ChevronDown, ChevronRight, Wrench } from '@lucide/icons';
import type { JSX, ReactNode } from 'react';
import { Icon } from '../../../shell/Icon.tsx';
import type { SegmentBaseProps } from './types.ts';

export interface ToolLineProps extends SegmentBaseProps {
    label: string;
    status: 'running' | 'done' | 'error';
    expanded: boolean;
    onToggle(): void;
    detail?: ReactNode;
}

export function ToolLine({
    segment,
    label,
    status,
    expanded,
    onToggle,
    detail,
}: ToolLineProps): JSX.Element {
    return (
        <div
            className={`d2-tool-line${expanded ? ' is-expanded' : ''}`}
            data-segment-id={segment.segmentId}
            data-segment-status={status}
        >
            <button
                type="button"
                className={`d2-segment-toggle${status === 'running' ? ' is-running d2-turn-shimmer' : ''}`}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
                onClick={onToggle}
            >
                <Icon icon={Wrench} size={14} />
                <span className="d2-segment-label">{label}</span>
                <span className={`d2-segment-status is-${status}`}>{status === 'done' ? 'Ran' : status}</span>
                <Icon icon={expanded ? ChevronDown : ChevronRight} size={13} />
            </button>
            {expanded ? <div className="d2-tool-detail" data-tool-detail>{detail}</div> : null}
        </div>
    );
}
