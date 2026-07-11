import { Users } from '@lucide/icons';
import type { JSX } from 'react';
import { Icon } from '../../../shell/Icon.tsx';

export interface CollabSegmentProps {
    agentId: string;
    runId: string;
    status: string;
    verdict?: string | null;
}

const TERMINAL_STATUSES = new Set(['completed', 'done', 'error', 'cancelled', 'interrupted']);

export function CollabSegment({
    agentId,
    runId,
    status,
    verdict,
}: CollabSegmentProps): JSX.Element {
    const terminal = TERMINAL_STATUSES.has(status);
    return (
        <div
            className="d2-collab-segment"
            data-agent-id={agentId}
            data-run-id={runId}
            data-segment-status={status}
        >
            <div className={`d2-turn-segment${terminal ? '' : ' is-running d2-turn-shimmer'}`}>
                <Icon icon={Users} size={14} />
                <span className="d2-segment-label">{agentId}</span>
                <span className={`d2-segment-status is-${terminal ? 'done' : 'running'}`}>{status}</span>
            </div>
            {terminal && verdict ? <div className="d2-collab-verdict" data-collab-verdict>{verdict}</div> : null}
        </div>
    );
}
