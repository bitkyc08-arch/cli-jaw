// 044 — one committed turn row: per-turn subscription only (useTurn/useTurnBody),
// never the whole turn array. Durable React keys are (turnId,turnSeq); the
// segmentId is a convergence key only (display dedupe), never a row key.
import { useEffect, useState, useSyncExternalStore, type JSX } from 'react';
import type { TurnSegment } from '../../../../../src/shared/chat-events.ts';
import { rowKey } from '../types.ts';
import { parseCollabIdentity } from '../adapters/collab-segment.ts';
import { parseWidgetDescriptor } from '../widgets/widget-segment-adapter.ts';
import type { TurnStore } from '../store/turn-store.ts';
import { useTurn, useTurnBody } from '../store/use-turn.ts';
import { MarkdownSegment } from './MarkdownSegment.tsx';
import { CollabSegment } from './segments/CollabSegment.tsx';
import { ThinkingSegment } from './segments/ThinkingSegment.tsx';
import { ToolLine } from './segments/ToolLine.tsx';
import { WidgetSegment } from './segments/WidgetSegment.tsx';
import { usePreferences } from '../../providers/preferences-provider.tsx';
import { renderCopy } from '../render/copy-catalog.ts';
import { getDetailController, type DetailController } from '../detail/detail-loader.ts';
import { ToolDetailPane } from '../detail/ToolDetailPane.tsx';

const EMPTY_DETAIL_SNAPSHOT = {
    phase: 'idle', resolvedRevision: null, totalBytes: null, lineCount: null,
    inlineText: null, chunks: [], error: null,
} as const;
const subscribeToNothing = (): (() => void) => () => {};
const emptyDetailSnapshot = () => EMPTY_DETAIL_SNAPSHOT;

export interface TurnRowProps {
    store: TurnStore;
    turnId: string;
}

interface ExpandedToolKey {
    segmentId: string;
    revision: string | null;
}

function detailDomId(turnId: string, segmentId: string): string {
    return `tool-detail-${turnId}-${segmentId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function WiredToolLine({
    store,
    row,
    expandedKey,
    onExpandedKey,
}: {
    store: TurnStore;
    row: Extract<TurnSegment, { type: 'tool' }> | TurnSegment;
    expandedKey: ExpandedToolKey | null;
    onExpandedKey(next: ExpandedToolKey | null): void;
}): JSX.Element {
    const controller: DetailController | null = row.detailRef ? getDetailController(store, row.detailRef) : null;
    const snapshot = useSyncExternalStore(
        controller?.subscribe ?? subscribeToNothing,
        controller?.snapshot ?? emptyDetailSnapshot,
        controller?.snapshot ?? emptyDetailSnapshot,
    );
    const revision = snapshot.resolvedRevision ?? null;
    const expanded = expandedKey?.segmentId === row.segmentId
        && (expandedKey.revision === null || expandedKey.revision === revision);
    const detailId = detailDomId(row.turnId, row.segmentId);
    const label = row.detailRef ? `Tool #${row.detailRef.traceSeq}` : 'Tool';
    const busy = ['opening', 'loading-inline', 'loading-range'].includes(snapshot.phase);

    useEffect(() => {
        if (expanded && revision !== null && expandedKey?.revision === null) {
            onExpandedKey({ segmentId: row.segmentId, revision });
        }
    }, [expanded, expandedKey?.revision, onExpandedKey, revision, row.segmentId]);

    return (
        <ToolLine
            segment={row}
            traceSeq={row.detailRef?.traceSeq}
            status={row.status === 'running' ? 'running' : row.status === 'error' ? 'error' : 'done'}
            expanded={expanded}
            onToggle={() => onExpandedKey(expanded ? null : { segmentId: row.segmentId, revision })}
            controller={controller ?? undefined}
            detailId={detailId}
            busy={busy}
            detail={controller && expanded ? <ToolDetailPane controller={controller} summaryLabel={label} detailId={detailId} /> : undefined}
        />
    );
}

/** display convergence: keep the LAST row per segmentId (Grok pair /
 *  coarse→full promotion collapse to their latest durable row) */
function lastPerSegment(rows: TurnSegment[]): TurnSegment[] {
    const byId = new Map<string, TurnSegment>();
    for (const row of rows) byId.set(row.segmentId, row);
    return [...byId.values()];
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function TurnRow({ store, turnId }: TurnRowProps): JSX.Element | null {
    const { locale } = usePreferences();
    const renderLocale = locale.locale === 'ko' ? 'ko' : 'en';
    const stub = useTurn(store, turnId);
    const body = useTurnBody(store, turnId);
    const [expandedTool, setExpandedTool] = useState<ExpandedToolKey | null>(null);
    const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
    if (!stub) return null;

    const rows = store.getTurnRows(turnId);
    const start = rows.find(r => r.type === 'turn_start');
    const end = rows.find(r => r.type === 'turn_end');
    // duration contract: lifecycle observedAt delta (never createdAt/providerAt)
    const durationMs = start && end ? end.observedAt - start.observedAt : null;

    const middles = lastPerSegment(rows.filter(r => r.type !== 'turn_start' && r.type !== 'turn_end'));
    const collabGroups = new Map<string, TurnSegment>();
    const items: JSX.Element[] = [];
    // the hydrated message body is turn-level: render it exactly once, on the
    // LAST assistant_text row (multiple text rows must not duplicate the body)
    const lastTextKey = [...middles].reverse().find(r => r.type === 'assistant_text');
    for (const row of middles) {
        const key = rowKey(row.turnId, row.turnSeq);
        if (row.type === 'thinking') {
            items.push(
                <ThinkingSegment
                    key={key}
                    segment={row}
                    fidelity={row.fidelity}
                    marker={row.thinkingMarker}
                    running={row.status === 'running'}
                />,
            );
        } else if (row.type === 'tool') {
            items.push(
                <WiredToolLine
                    key={key}
                    store={store}
                    row={row}
                    expandedKey={expandedTool}
                    onExpandedKey={setExpandedTool}
                />,
            );
        } else if (row.type === 'collab') {
            collabGroups.set(row.segmentId, row);
        } else if (row.type === 'widget') {
            const descriptor = parseWidgetDescriptor(row);
            items.push(
                <WidgetSegment
                    key={key}
                    descriptor={descriptor}
                    expanded={expandedWidget === key}
                    onToggle={() => setExpandedWidget(current => (current === key ? null : key))}
                />,
            );
        } else if (row.type === 'assistant_text') {
            if (lastTextKey && row.turnSeq === lastTextKey.turnSeq) {
                // committed assistant text renders through the full markdown +
                // sanitize pipeline (streaming preview is the live tail's mode)
                items.push(<MarkdownSegment key={key} text={body?.text ?? ''} />);
            }
        }
    }
    for (const row of collabGroups.values()) {
        const join = parseCollabIdentity(row);
        if (!join) continue;
        items.push(
            <CollabSegment
                key={rowKey(row.turnId, row.turnSeq)}
                agentId={join.agentId}
                runId={join.runId}
                status={row.status}
            />,
        );
    }

    return (
        <article className="d2-turn-row" data-turn-id={turnId} data-terminal={stub.terminalStatus}>
            <header className="d2-turn-header">
                <span className="d2-turn-title">{renderCopy(renderLocale, 'turn.title')}</span>
                {durationMs !== null ? (
                    <span className="d2-turn-duration" data-testid="turn-duration" data-duration-ms={durationMs}>
                        {formatDuration(durationMs)}
                    </span>
                ) : null}
            </header>
            {items}
            <footer className="d2-turn-footer" data-status={stub.terminalStatus} />
        </article>
    );
}
