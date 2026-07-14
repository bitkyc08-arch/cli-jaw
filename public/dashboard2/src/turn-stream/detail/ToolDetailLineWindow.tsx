import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { DetailChunk, DetailController, DetailSnapshot } from './detail-loader.ts';

const ROW_HEIGHT = 20; const OVERSCAN = 8; const MAX_RANGE = 262_144;
export interface ToolDetailLineWindowProps { controller: DetailController; snapshot: DetailSnapshot; onViewState?: (state: { scrollLine: number; selectionAnchor?: number; activeSearchHit?: number }) => void; initialScrollLine?: number }

export function ToolDetailLineWindow({ controller, snapshot, onViewState, initialScrollLine = 0 }: ToolDetailLineWindowProps): ReactElement {
    const viewport = useRef<HTMLDivElement>(null); const [scrollTop, setScrollTop] = useState(initialScrollLine * ROW_HEIGHT); const [height, setHeight] = useState(240);
    const chunks: readonly DetailChunk[] = snapshot.inlineText !== null ? [{ offset: 0, endExclusive: snapshot.totalBytes ?? 0, text: snapshot.inlineText, firstLine: 1, lastLine: snapshot.lineCount ?? 1, ansiStateBefore: null, ansiStateAfter: null }] : snapshot.chunks;
    const lines = useMemo(() => chunks.flatMap(chunk => chunk.text.split('\n').map((text, index) => ({ number: chunk.firstLine + index, text }))), [chunks]);
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN); const count = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2; const visible = lines.slice(first, first + count);
    useEffect(() => { const node = viewport.current; if (!node) return; node.scrollTop = initialScrollLine * ROW_HEIGHT; const observer = new ResizeObserver(entries => setHeight(entries[0]?.contentRect.height ?? 240)); observer.observe(node); return () => observer.disconnect(); }, [initialScrollLine]);
    useEffect(() => { if (snapshot.phase !== 'ready-ranged' || visible.length === 0) return; const wanted = visible[0]?.number ?? 1; if (!chunks.some(chunk => wanted >= chunk.firstLine && wanted <= chunk.lastLine)) void controller.seekLine(wanted); }, [chunks, controller, snapshot.phase, visible]);
    useEffect(() => { if (snapshot.phase === 'loading-range' && chunks.length === 0) void controller.loadRange(0, MAX_RANGE); }, [chunks.length, controller, snapshot.phase]);
    return <div ref={viewport} className="d2-tool-detail__viewport" tabIndex={0} onScroll={event => { const top = event.currentTarget.scrollTop; setScrollTop(top); onViewState?.({ scrollLine: Math.floor(top / ROW_HEIGHT) }); }}>
        <div className="d2-tool-detail__spacer" style={{ height: Math.max(snapshot.lineCount ?? 0, lines.length) * ROW_HEIGHT }}>
            {visible.map(line => <div className="d2-tool-detail__line" key={line.number} style={{ transform: `translateY(${(line.number - 1) * ROW_HEIGHT}px)` }}><span className="d2-tool-detail__gutter" aria-hidden="true">{line.number}</span><span className="d2-tool-detail__text">{line.text}</span></div>)}
        </div>
    </div>;
}
