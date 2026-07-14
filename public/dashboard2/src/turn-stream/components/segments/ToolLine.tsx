import { Check, ChevronDown, ChevronRight, Copy, Wrench, X } from '@lucide/icons';
import { useState, type JSX, type ReactNode } from 'react';
import { Icon } from '../../../shell/Icon.tsx';
import { usePreferences } from '../../../providers/preferences-provider.tsx';
import { renderCopy } from '../../render/copy-catalog.ts';
import type { SegmentBaseProps } from './types.ts';
import type { DetailController } from '../../detail/detail-loader.ts';
import { copyFullDetail } from '../../detail/detail-copy.ts';

export interface ToolLineProps extends SegmentBaseProps {
    label?: string;
    traceSeq?: number | undefined;
    status: 'running' | 'done' | 'error';
    expanded: boolean;
    onToggle(): void;
    detail?: ReactNode;
    controller?: DetailController | undefined;
    detailId?: string | undefined;
    busy?: boolean | undefined;
}

export function ToolLine({
    segment,
    label,
    traceSeq,
    status,
    expanded,
    onToggle,
    detail,
    controller,
    detailId,
    busy = false,
}: ToolLineProps): JSX.Element {
    const { locale } = usePreferences();
    const renderLocale = locale.locale === 'ko' ? 'ko' : 'en';
    const renderedLabel = label ?? (traceSeq === undefined
        ? renderCopy(renderLocale, 'tool.labelPlain')
        : renderCopy(renderLocale, 'tool.label', { seq: traceSeq }));
    const statusCopy = renderCopy(renderLocale, status === 'done'
        ? 'tool.status.ran'
        : status === 'running' ? 'tool.status.running' : 'tool.status.error');
    const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
    const hasDetail = Boolean(controller || detail);
    const mountedDetailId = expanded && hasDetail ? detailId : undefined;
    // TODO(i18n): replace these two inline states when the shared catalog owns copy progress/error keys.
    const copyStateText = copyState === 'copying'
        ? (renderLocale === 'ko' ? '복사 중…' : 'Copying…')
        : copyState === 'copied' ? renderCopy(renderLocale, 'code.copied')
            : copyState === 'error' ? (renderLocale === 'ko' ? '복사 실패' : 'Copy failed') : '';

    const copyDetail = async (): Promise<void> => {
        if (!controller || copyState === 'copying') return;
        setCopyState('copying');
        try {
            await copyFullDetail(controller);
            setCopyState('copied');
        } catch {
            setCopyState('error');
        }
    };
    return (
        <div
            className={`d2-tool-line${expanded ? ' is-expanded' : ''}`}
            data-segment-id={segment.segmentId}
            data-segment-status={status}
        >
            <button
                type="button"
                className={`d2-segment-toggle${status === 'running' ? ' is-running d2-turn-shimmer' : ''}`}
                aria-expanded={hasDetail ? expanded : undefined}
                aria-controls={mountedDetailId}
                aria-busy={hasDetail && busy ? true : undefined}
                disabled={!hasDetail}
                aria-label={`${renderCopy(renderLocale, expanded ? 'tool.collapse' : 'tool.expand')} ${renderedLabel}`}
                onClick={onToggle}
            >
                <Icon icon={Wrench} size={14} />
                <span className="d2-segment-label">{renderedLabel}</span>
                <span className={`d2-segment-status is-${status}`}>{statusCopy}</span>
                <Icon icon={expanded ? ChevronDown : ChevronRight} size={13} />
            </button>
            <button
                type="button"
                className="d2-tool-copy"
                aria-label={`${renderCopy(renderLocale, 'code.copy')} ${renderedLabel}`}
                aria-busy={copyState === 'copying' ? true : undefined}
                disabled={!controller || copyState === 'copying'}
                onClick={() => { void copyDetail(); }}
            >
                <Icon icon={copyState === 'copied' ? Check : copyState === 'error' ? X : Copy} size={13} />
                <span className="d2-sr-only" role="status">
                    {copyStateText}
                </span>
            </button>
            {expanded && hasDetail ? (controller ? detail : <div id={mountedDetailId} className="d2-tool-detail" data-tool-detail>{detail}</div>) : null}
        </div>
    );
}
