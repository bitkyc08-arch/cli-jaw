import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DetailController, DetailSnapshot } from './detail-loader.ts';
import { ToolDetailLineWindow } from './ToolDetailLineWindow.tsx';

export interface ToolDetailViewState { scrollLine: number; selectionAnchor?: number; activeSearchHit?: number }
const savedViews = new Map<string, ToolDetailViewState>();
export function clearToolDetailViewState(detailId: string): void { savedViews.delete(detailId); }

export function ToolDetailPane({ controller, summaryLabel, detailId }: { controller: DetailController; summaryLabel: string; detailId: string }): ReactElement {
    const [snapshot, setSnapshot] = useState<DetailSnapshot>(() => controller.snapshot()); const view = useRef(savedViews.get(detailId) ?? { scrollLine: 0 });
    useEffect(() => { controller.pin('expanded'); const unsubscribe = controller.subscribe(() => setSnapshot(controller.snapshot())); void controller.open(); return () => { unsubscribe(); savedViews.set(detailId, view.current); controller.abort(); controller.collapse(Date.now()); controller.unpin('expanded'); }; }, [controller, detailId]);
    const retry = (): void => { controller.abort(); void controller.open(); };
    const terminal = snapshot.phase === 'unavailable' ? ['Detail unavailable', true] as const : snapshot.phase === 'gone' ? ['Stored output is gone', false] as const : snapshot.phase === 'stale-revision' ? ['Output revision changed. Reopen the detail.', true] as const : snapshot.phase === 'error' ? [snapshot.error ?? 'Could not load detail', true] as const : null;
    const loading = ['idle', 'opening', 'loading-inline', 'loading-range'].includes(snapshot.phase);
    return <section id={detailId} data-tool-detail className={`d2-tool-detail is-${snapshot.phase}`} role="region" aria-label={`${summaryLabel} output`} aria-busy={loading}>
        {loading ? <div className="d2-tool-detail__skeleton" aria-hidden="true">{[0, 1, 2, 3].map(row => <span key={row} />)}</div> : null}
        {terminal ? <div className="d2-tool-detail__state" role="status"><span>{terminal[0]}</span>{terminal[1] ? <button type="button" onClick={retry}>Retry</button> : null}</div> : null}
        {snapshot.phase === 'ready-inline' || snapshot.phase === 'ready-ranged' ? <ToolDetailLineWindow controller={controller} snapshot={snapshot} initialScrollLine={view.current.scrollLine} onViewState={next => { view.current = { ...view.current, ...next }; }} /> : null}
    </section>;
}
