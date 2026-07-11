import { FileSearch } from '@lucide/icons';
import type { JSX } from 'react';
import { Icon } from '../../../shell/Icon.tsx';

export interface ExploreAggregateProps {
    count: number;
    running?: boolean;
}

export function ExploreAggregate({ count, running = false }: ExploreAggregateProps): JSX.Element {
    const safeCount = Math.max(0, Math.trunc(count));
    return (
        <div className={`d2-turn-segment d2-explore-aggregate${running ? ' is-running d2-turn-shimmer' : ''}`}>
            <Icon icon={FileSearch} size={14} />
            <span className="d2-segment-label">Explored {safeCount} {safeCount === 1 ? 'file' : 'files'}</span>
        </div>
    );
}
