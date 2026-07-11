import { Brain, LockKeyhole } from '@lucide/icons';
import type { JSX } from 'react';
import type { ThinkingMarker, TurnFidelity } from '../../../../../../src/shared/chat-events.ts';
import { Icon } from '../../../shell/Icon.tsx';
import type { SegmentBaseProps } from './types.ts';

export type { SegmentBaseProps } from './types.ts';

export interface ThinkingSegmentProps extends SegmentBaseProps {
    fidelity: TurnFidelity | null;
    marker: ThinkingMarker | null;
    running: boolean;
}

interface ThinkingPresentation {
    label: string;
    detailPolicy: 'live' | 'on-demand' | 'locked' | 'none';
    coarse: boolean;
    locked: boolean;
}

function presentationFor(
    marker: ThinkingMarker,
    fidelity: Exclude<TurnFidelity, 'text_only'>,
): ThinkingPresentation | null {
    const coarse = fidelity === 'coarse';
    switch (marker) {
        case 'streaming':
            return { label: coarse ? 'Thinking' : 'Thinking live', detailPolicy: coarse ? 'none' : 'live', coarse, locked: false };
        case 'plaintext':
            return { label: 'Thinking', detailPolicy: coarse ? 'none' : 'on-demand', coarse, locked: false };
        case 'encrypted':
            return { label: 'Thinking is encrypted', detailPolicy: 'locked', coarse, locked: true };
        case 'token_fallback':
            return { label: 'Thinking with token summary', detailPolicy: 'none', coarse, locked: false };
        case 'pre_tool_text':
            return { label: 'Thinking before tool use', detailPolicy: 'none', coarse, locked: false };
        case 'plan':
            return { label: 'Planning', detailPolicy: 'none', coarse, locked: false };
        case 'planner':
            return { label: 'Planner thinking', detailPolicy: 'none', coarse, locked: false };
        default:
            return null;
    }
}

export function ThinkingSegment({
    segment,
    fidelity,
    marker,
    running,
}: ThinkingSegmentProps): JSX.Element | null {
    if (fidelity === null || fidelity === 'text_only' || marker === null) return null;

    const presentation = presentationFor(marker, fidelity);
    if (!presentation) return null;

    return (
        <div
            className={`d2-turn-segment d2-thinking-segment${running ? ' is-running d2-turn-shimmer' : ''}`}
            data-segment-id={segment.segmentId}
            data-thinking-marker={marker}
            data-fidelity={fidelity}
            data-detail-policy={presentation.detailPolicy}
            data-detail-fetch-allowed={presentation.detailPolicy === 'on-demand' || presentation.detailPolicy === 'live' ? 'true' : 'false'}
            data-segment-status={segment.status}
        >
            <Icon icon={presentation.locked ? LockKeyhole : Brain} size={14} />
            <span className="d2-segment-label">{presentation.label}</span>
            {presentation.coarse && !presentation.locked ? <span className="d2-segment-badge">Coarse</span> : null}
        </div>
    );
}
