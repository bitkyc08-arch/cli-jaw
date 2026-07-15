// 045 — live tail isolation: renders ACTIVE turns only (liveTurns map, never
// T0/T1). Streaming body arrives via the traceRunId→turnId join; the widget
// policy auto-inflates at most the LATEST active turn. Fold-in to committed
// is the 042 store's single transaction — this component just stops
// rendering the turn in the same snapshot the committed list mounts it.
import { useState, useSyncExternalStore, type JSX } from 'react';
import type { TurnSegment } from '../../../../../src/shared/chat-events.ts';
import { rowKey } from '../types.ts';
import type { TurnStore } from '../store/turn-store.ts';
import { useLiveTurns } from '../store/use-turn.ts';
import { MarkdownSegment } from '../components/MarkdownSegment.tsx';
import { ThinkingSegment } from '../components/segments/ThinkingSegment.tsx';
import { ToolLine } from '../components/segments/ToolLine.tsx';
import { WidgetSegment } from '../components/segments/WidgetSegment.tsx';
import { parseWidgetDescriptor } from '../widgets/widget-segment-adapter.ts';
import { prepareFoldSnapshot } from './fold-live-turn.ts';
import { getDetailController, type DetailController } from '../detail/detail-loader.ts';
import { ToolDetailPane } from '../detail/ToolDetailPane.tsx';
import { useRenderActionPorts } from '../../providers/render-action-ports.tsx';
import { workerApiBase } from '../detail/detail-client.ts';

const EMPTY_DETAIL_SNAPSHOT = {
    phase: 'idle', resolvedRevision: null, totalBytes: null, lineCount: null,
    inlineText: null, chunks: [], error: null,
} as const;
const subscribeToNothing = (): (() => void) => () => {};
const emptyDetailSnapshot = () => EMPTY_DETAIL_SNAPSHOT;

export interface LiveTurnTailProps {
    store: TurnStore;
}

function detailKey(row: TurnSegment, revision: string | null): string {
    return `${row.turnId}|${row.segmentId}|${revision ?? 'pending'}`;
}

function LiveToolLine({
    store,
    row,
    expanded,
    onToggle,
}: {
    store: TurnStore;
    row: TurnSegment;
    expanded: boolean;
    onToggle(revision: string | null): void;
}): JSX.Element {
    const { workerPort } = useRenderActionPorts();
    const controller: DetailController | null = row.detailRef && workerPort !== null
        ? getDetailController(store, row.detailRef, { apiBase: workerApiBase(workerPort) })
        : null;
    const snapshot = useSyncExternalStore(
        controller?.subscribe ?? subscribeToNothing,
        controller?.snapshot ?? emptyDetailSnapshot,
        controller?.snapshot ?? emptyDetailSnapshot,
    );
    const id = `live-tool-detail-${row.turnId}-${row.segmentId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const label = row.detailRef ? `Tool #${row.detailRef.traceSeq}` : 'Tool';
    return <ToolLine
        segment={row}
        traceSeq={row.detailRef?.traceSeq}
        status={row.status === 'running' ? 'running' : row.status === 'error' ? 'error' : 'done'}
        expanded={expanded}
        onToggle={() => onToggle(snapshot.resolvedRevision ?? null)}
        controller={controller ?? undefined}
        detailId={id}
        busy={['opening', 'loading-inline', 'loading-range'].includes(snapshot.phase)}
        detail={controller && expanded ? <ToolDetailPane controller={controller} summaryLabel={label} detailId={id} /> : undefined}
    />;
}

export function LiveTurnTail({ store }: LiveTurnTailProps): JSX.Element | null {
    const { workerPort } = useRenderActionPorts();
    const live = useLiveTurns(store);
    const [manualExpanded, setManualExpanded] = useState<string | null>(null);
    const [manualCollapseLatches, setManualCollapseLatches] = useState<ReadonlySet<string>>(() => new Set());
    const [widgetCollapseLatches, setWidgetCollapseLatches] = useState<ReadonlySet<string>>(() => new Set());
    if (!live.turnIds.length) return null;
    const latest = live.turnIds[live.turnIds.length - 1];
    const latestModel = store.getLiveTurn(latest);
    const autoTarget = latestModel?.rows
        .filter(row => row.type === 'tool' && row.status === 'running' && row.detailRef)
        .sort((a, b) => b.turnSeq - a.turnSeq)[0] ?? null;
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
                                const controller = row.detailRef && workerPort !== null
                                    ? getDetailController(store, row.detailRef, { apiBase: workerApiBase(workerPort) })
                                    : null;
                                const revision = controller?.snapshot().resolvedRevision ?? null;
                                const key = detailKey(row, revision);
                                const pendingKey = detailKey(row, null);
                                const autoExpanded = autoTarget?.turnId === row.turnId
                                    && autoTarget.segmentId === row.segmentId
                                    && !manualCollapseLatches.has(key)
                                    && !manualCollapseLatches.has(pendingKey);
                                const expanded = manualExpanded === key || manualExpanded === pendingKey
                                    || (manualExpanded === null && autoExpanded);
                                return (
                                    <LiveToolLine
                                        key={key}
                                        store={store}
                                        row={row}
                                        expanded={expanded}
                                        onToggle={resolvedRevision => {
                                            const resolvedKey = detailKey(row, resolvedRevision);
                                            if (expanded) {
                                                setManualExpanded(null);
                                                if (autoTarget?.turnId === row.turnId && autoTarget.segmentId === row.segmentId) {
                                                    setManualCollapseLatches(current => new Set(current).add(resolvedKey));
                                                }
                                            } else {
                                                setManualExpanded(resolvedKey);
                                            }
                                        }}
                                    />
                                );
                            }
                            if (row.type === 'widget') {
                                // 016 policy: only the LATEST active turn may
                                // auto-inflate its widget; older live turns
                                // show the fixed placeholder
                                const descriptor = parseWidgetDescriptor(row);
                                const latchKey = `${row.turnId}|${row.segmentId}|${descriptor.revision}`;
                                const expanded = isLatest && !widgetCollapseLatches.has(latchKey);
                                return (
                                    <WidgetSegment
                                        key={key}
                                        descriptor={descriptor}
                                        expanded={expanded}
                                        onToggle={() => setWidgetCollapseLatches(current => {
                                            const next = new Set(current);
                                            if (expanded) next.add(latchKey); else next.delete(latchKey);
                                            return next;
                                        })}
                                        chatId={row.sessionId}
                                        identity={{ scopeKey: store.getScopeKey(), turnId: row.turnId, segmentId: row.segmentId }}
                                        promotionSource="turn-widget"
                                    />
                                );
                            }
                            return null;
                        })}
                        {body ? (
                            <MarkdownSegment
                                text={body}
                                mode="streaming"
                                identity={{ scopeKey: store.getScopeKey(), turnId, segmentId: `${turnId}:body` }}
                            />
                        ) : null}
                    </article>
                );
            })}
        </div>
    );
}
