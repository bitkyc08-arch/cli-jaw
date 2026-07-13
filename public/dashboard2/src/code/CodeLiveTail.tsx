import { type JSX } from 'react';
import type { TurnSegment } from '../../../../src/shared/chat-events.ts';
import { parseCollabIdentity } from '../turn-stream/adapters/collab-segment.ts';
import { MarkdownSegment } from '../turn-stream/components/MarkdownSegment.tsx';
import { CollabSegment } from '../turn-stream/components/segments/CollabSegment.tsx';
import { ThinkingSegment } from '../turn-stream/components/segments/ThinkingSegment.tsx';
import { ToolLine } from '../turn-stream/components/segments/ToolLine.tsx';
import { WidgetSegment } from '../turn-stream/components/segments/WidgetSegment.tsx';
import { prepareFoldSnapshot } from '../turn-stream/live/fold-live-turn.ts';
import type { TurnStore } from '../turn-stream/store/turn-store.ts';
import { useLiveTurns } from '../turn-stream/store/use-turn.ts';
import { rowKey } from '../turn-stream/types.ts';
import { parseWidgetDescriptor } from '../turn-stream/widgets/widget-segment-adapter.ts';

export interface CodeLiveTailProps {
    store: TurnStore;
}

function lastPerSegment(rows: TurnSegment[]): TurnSegment[] {
    const lastIndex = new Map<string, number>();
    rows.forEach((row, index) => lastIndex.set(row.segmentId, index));
    return rows.filter((row, index) => lastIndex.get(row.segmentId) === index);
}

export function CodeLiveTail({ store }: CodeLiveTailProps): JSX.Element | null {
    const live = useLiveTurns(store);
    if (!live.turnIds.length) return null;
    const latest = live.turnIds[live.turnIds.length - 1];
    return (
        <div className="d2-live-tail" data-testid="live-turn-tail" data-live-count={live.turnIds.length}>
            {live.turnIds.map(turnId => {
                const model = store.getLiveTurn(turnId);
                if (!model) return null;
                const body = store.getLiveBodyForTurn(turnId);
                const isLatest = turnId === latest;
                const fold = prepareFoldSnapshot(model, isLatest);
                void fold.shouldCollapseWidget;
                return (
                    <article
                        key={turnId}
                        className="d2-live-turn"
                        data-turn-id={turnId}
                        data-live="1"
                        style={{ minHeight: `${fold.placeholderHeight}px` }}
                    >
                        {lastPerSegment(model.rows).map(row => {
                            const key = rowKey(row.turnId, row.turnSeq);
                            if (row.type === 'thinking') {
                                return (
                                    <ThinkingSegment
                                        key={key}
                                        segment={row}
                                        fidelity={row.fidelity}
                                        marker={row.thinkingMarker}
                                        running={row.status === 'running'}
                                    />
                                );
                            }
                            if (row.type === 'tool') {
                                return (
                                    <ToolLine
                                        key={key}
                                        segment={row}
                                        label={row.detailRef ? `Tool #${row.detailRef.traceSeq}` : 'Tool'}
                                        status={row.status === 'running' ? 'running' : row.status === 'error' ? 'error' : 'done'}
                                        expanded={false}
                                        onToggle={() => {}}
                                    />
                                );
                            }
                            if (row.type === 'collab') {
                                const identity = parseCollabIdentity(row);
                                if (!identity) return null;
                                return (
                                    <CollabSegment
                                        key={key}
                                        agentId={identity.agentId}
                                        runId={identity.runId}
                                        status={row.status}
                                    />
                                );
                            }
                            if (row.type === 'widget') {
                                return (
                                    <WidgetSegment
                                        key={key}
                                        descriptor={parseWidgetDescriptor(row)}
                                        expanded={isLatest}
                                        onToggle={() => {}}
                                    />
                                );
                            }
                            return null;
                        })}
                        {body ? <MarkdownSegment text={body} streaming /> : null}
                    </article>
                );
            })}
        </div>
    );
}
