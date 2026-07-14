import { ChevronDown, ChevronRight, Wrench } from '@lucide/icons';
import type { JSX, ReactNode } from 'react';
import { Icon } from '../../../shell/Icon.tsx';
import { usePreferences } from '../../../providers/preferences-provider.tsx';
import { renderCopy } from '../../render/copy-catalog.ts';
import type { SegmentBaseProps } from './types.ts';

export interface ToolLineProps extends SegmentBaseProps {
    label?: string;
    traceSeq?: number | undefined;
    status: 'running' | 'done' | 'error';
    expanded: boolean;
    onToggle(): void;
    detail?: ReactNode;
}

export function ToolLine({
    segment,
    label,
    traceSeq,
    status,
    expanded,
    onToggle,
    detail,
}: ToolLineProps): JSX.Element {
    const { locale } = usePreferences();
    const renderLocale = locale.locale === 'ko' ? 'ko' : 'en';
    const renderedLabel = label ?? (traceSeq === undefined
        ? renderCopy(renderLocale, 'tool.labelPlain')
        : renderCopy(renderLocale, 'tool.label', { seq: traceSeq }));
    const statusCopy = renderCopy(renderLocale, status === 'done'
        ? 'tool.status.ran'
        : status === 'running' ? 'tool.status.running' : 'tool.status.error');
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
                aria-label={`${renderCopy(renderLocale, expanded ? 'tool.collapse' : 'tool.expand')} ${renderedLabel}`}
                onClick={onToggle}
            >
                <Icon icon={Wrench} size={14} />
                <span className="d2-segment-label">{renderedLabel}</span>
                <span className={`d2-segment-status is-${status}`}>{statusCopy}</span>
                <Icon icon={expanded ? ChevronDown : ChevronRight} size={13} />
            </button>
            {expanded ? <div className="d2-tool-detail" data-tool-detail>{detail}</div> : null}
        </div>
    );
}
