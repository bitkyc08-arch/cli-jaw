// 045 — live tail isolation: renders ACTIVE turns only (liveTurns map, never
// T0/T1). Streaming body arrives via the traceRunId→turnId join; the widget
// policy auto-inflates at most the LATEST active turn. Fold-in to committed
// is the 042 store's single transaction — this component just stops
// rendering the turn in the same snapshot the committed list mounts it.
import { type JSX } from 'react';
import { rowKey } from '../types.ts';
import type { TurnStore } from '../store/turn-store.ts';
import { useLiveTurns } from '../store/use-turn.ts';
import { MarkdownSegment } from '../components/MarkdownSegment.tsx';
import { ThinkingSegment } from '../components/segments/ThinkingSegment.tsx';
import { ToolLine } from '../components/segments/ToolLine.tsx';
import { WidgetSegment } from '../components/segments/WidgetSegment.tsx';
import { parseWidgetDescriptor } from '../widgets/widget-segment-adapter.ts';
import { prepareFoldSnapshot } from './fold-live-turn.ts';

export interface LiveTurnTailProps {
    store: TurnStore;
}

export function LiveTurnTail({ store }: LiveTurnTailProps): JSX.Element | null {
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
                // fold stability: reserve the terminal placeholder height so
                // turn_end fold-in does not shift the scroll frame
                const fold = prepareFoldSnapshot(model, isLatest);
                void fold.shouldCollapseWidget; // fold-time policy — applied at turn_end, not render
                return (
                    <article
                        key={turnId}
                        className="d2-live-turn"
                        data-turn-id={turnId}
                        data-live="1"
                        style={{ minHeight: `${fold.placeholderHeight}px` }}
                    >
                        {model.rows.map(row => {
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
                            if (row.type === 'widget') {
                                // 016 policy: only the LATEST active turn may
                                // auto-inflate its widget; older live turns
                                // show the fixed placeholder
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
