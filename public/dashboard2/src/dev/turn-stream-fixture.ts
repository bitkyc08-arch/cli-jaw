// 040.2 — dev/test-only fixture measurement surface.
// Renders a MINIMAL virtualized turn-stream (NOT the 044 component tree) so the
// 040 budget harness can pin DOM/heap/frame/anchor budgets plus the v4 shell
// assertions (700px transcript, left-column placement, running shimmer).
// Production guard: never statically imported; module refuses to run in PROD.
import { createElement as h, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SegmentedMessageItem, TurnSegment } from '../../../../src/shared/chat-events.ts';

if (import.meta.env.PROD) {
    throw new Error('turn-stream-fixture is a dev/test-only module and must not ship in production bundles');
}

export interface FixtureHandle {
    rowCount(): number;
    diagnostics(): { rowCount: number; prependedRows: number; retainedStreamRows: number; streamRetentionCap: number };
    setSidePane(open: boolean): void;
    prepend(rows: SegmentedMessageItem[]): void;
    append(row: SegmentedMessageItem): void;
    completeOpenTurns(): void;
    totalSize(): number;
    scrollToIndex(index: number): void;
    cycleSidePaneTab(): string;
}

// The fixture's 20 Hz append driver represents the currently hydrated T2 tail,
// not durable transcript storage. Keeping every synthetic DTO here bypasses the
// product TurnStore's 200-turn cap and makes the measurement harness its own
// unbounded cache.
const STREAM_RETENTION_ROWS = 200;

declare global {
    interface Window { __jawTurnStreamFixture?: FixtureHandle }
}

const STYLE = `
.d2fix-shell{position:fixed;inset:0;display:grid;grid-template-columns:minmax(0,1fr) 1px minmax(340px,.45fr);background:#0d0f12;color:#e8eaed;font:14px/1.5 -apple-system,sans-serif}
.d2fix-shell[data-side-pane="closed"]{grid-template-columns:minmax(0,1fr) 0 0}
.d2fix-main{min-width:0;display:flex;flex-direction:column}
.d2fix-divider{background:rgba(255,255,255,.08)}
.d2fix-side{overflow:hidden}
.d2fix-scroll{flex:1;overflow-y:auto;contain:strict}
.d2fix-transcript{max-width:700px;margin:0 auto;width:100%;position:relative}
.d2fix-row{position:absolute;top:0;left:0;width:100%;box-sizing:border-box;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.04)}
.d2fix-seg{color:#6f757e;font-size:12px}
.d2fix-seg[data-shimmer="1"]{background:linear-gradient(100deg,#4a4f57 40%,rgba(255,255,255,.52) 50%,#4a4f57 60%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:d2fix-shimmer 2.2s linear infinite}
@keyframes d2fix-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
`;

function segLine(seg: TurnSegment): JSX.Element {
    const running = seg.status === 'running';
    return h('div', {
        key: `${seg.segmentId}#${seg.turnSeq}`,
        className: 'd2fix-seg',
        'data-seg-type': seg.type,
        'data-seg-status': seg.status,
        'data-shimmer': running ? '1' : '0',
    }, `${seg.type} · ${seg.status}${seg.thinkingMarker ? ` · ${seg.thinkingMarker}` : ''}`);
}

interface SurfaceProps {
    initial: SegmentedMessageItem[];
    expose: (handle: FixtureHandle) => void;
}

function FixtureSurface({ initial, expose }: SurfaceProps): JSX.Element {
    const [rows, setRows] = useState(initial);
    const [sidePane, setSidePane] = useState(true);
    const [sidePaneTab, setSidePaneTab] = useState(0);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const pendingPrepend = useRef<number | null>(null);
    const prependedRows = useRef(0);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (index) => 56 + Math.min(160, Math.floor(rows[index].content.length / 4)),
        overscan: 8,
        getItemKey: (index) => rows[index].id,
    });

    // Prepend anchor compensation (vanilla baseline parity: capture/restore).
    const totalSize = virtualizer.getTotalSize();
    const prevTotal = useRef(totalSize);
    useLayoutEffect(() => {
        if (pendingPrepend.current !== null && scrollRef.current) {
            const delta = totalSize - prevTotal.current;
            if (delta > 0) scrollRef.current.scrollTop += delta;
            pendingPrepend.current = null;
        }
        prevTotal.current = totalSize;
    }, [totalSize]);

    useLayoutEffect(() => {
        expose({
            rowCount: () => rows.length,
            diagnostics: () => ({
                rowCount: rows.length,
                prependedRows: prependedRows.current,
                retainedStreamRows: Math.max(0, rows.length - initial.length - prependedRows.current),
                streamRetentionCap: STREAM_RETENTION_ROWS,
            }),
            setSidePane: (open: boolean) => setSidePane(open),
            prepend: (extra: SegmentedMessageItem[]) => {
                pendingPrepend.current = extra.length;
                prependedRows.current += extra.length;
                setRows(prev => [...extra, ...prev]);
            },
            append: (row: SegmentedMessageItem) => setRows(prev => {
                const cap = initial.length + prependedRows.current + STREAM_RETENTION_ROWS;
                if (prev.length < cap) return [...prev, row];
                // Preserve baseline + prepended history and replace only the
                // oldest synthetic stream-tail row.
                const oldestStreamIndex = prependedRows.current + initial.length;
                return [...prev.slice(0, oldestStreamIndex), ...prev.slice(oldestStreamIndex + 1), row];
            }),
            completeOpenTurns: () => setRows(prev => prev.map(row => ({
                ...row,
                turn_segments: row.turn_segments.map(seg =>
                    seg.status === 'running' ? { ...seg, status: 'done' } : seg),
            }))),
            totalSize: () => virtualizer.getTotalSize(),
            scrollToIndex: (index: number) => virtualizer.scrollToIndex(index, { align: 'start' }),
            cycleSidePaneTab: () => {
                const tabs = ['terminal', 'browser', 'files', 'notes', 'board', 'reminders'];
                const next = (sidePaneTab + 1) % tabs.length;
                setSidePaneTab(next);
                return tabs[next];
            },
        });
    });

    const items = virtualizer.getVirtualItems();
    return h('div', { className: 'd2fix-shell', 'data-side-pane': sidePane ? 'open' : 'closed' },
        h('div', { className: 'd2fix-main' },
            h('div', { ref: scrollRef, className: 'd2fix-scroll', 'data-testid': 'fixture-scroll' },
                h('div', {
                    className: 'd2fix-transcript',
                    'data-testid': 'fixture-transcript',
                    style: { height: `${totalSize}px` },
                }, items.map(item => {
                    const row = rows[item.index];
                    return h('div', {
                        key: item.key,
                        className: 'd2fix-row',
                        'data-index': item.index,
                        'data-turn-id': row.turn_id ?? '',
                        ref: virtualizer.measureElement,
                        style: { transform: `translateY(${item.start}px)` },
                    },
                        h('div', null, row.content.slice(0, 120)),
                        ...row.turn_segments.map(segLine));
                }))),
        ),
        h('div', { className: 'd2fix-divider' }),
        h('div', { className: 'd2fix-side', 'data-testid': 'fixture-side-pane', 'data-active-tab': ['terminal', 'browser', 'files', 'notes', 'board', 'reminders'][sidePaneTab] }));
}

export function mountTurnStreamFixture(messages: SegmentedMessageItem[]): Promise<FixtureHandle> {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const host = document.createElement('div');
    host.id = 'd2fix-host';
    document.body.appendChild(host);
    return new Promise((resolve) => {
        const expose = (handle: FixtureHandle) => {
            window.__jawTurnStreamFixture = handle;
            resolve(handle);
        };
        createRoot(host).render(h(FixtureSurface, { initial: messages, expose }));
    });
}
